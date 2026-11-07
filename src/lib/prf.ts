// WebAuthn PRF owner derivation.
//
// The problem this solves: the OS passkey picker (navigator.credentials.get
// with an empty allowCredentials) returns only a credential id + a signature —
// never the public key. Our smart-account address is derived from the owner, so
// a passkey whose public key we never stored (cleared storage, different
// origin/port/profile, or a passkey synced from another device) could not be
// re-derived. That made "use a different passkey" fail and made accounts
// non-recoverable across devices.
//
// The fix: derive the owner from the WebAuthn PRF extension instead of from a
// stored P256 public key. PRF returns a deterministic secret for a fixed salt
// on every get() — INCLUDING the OS picker — and for iCloud Keychain / Google
// Password Manager passkeys that secret is STABLE across every synced device.
// So the same passkey always yields the same private key, hence the same
// counterfactual address, anywhere, with nothing stored.
//
// PRF is runtime-detected. If an authenticator doesn't support it, callers fall
// back to the stored-publicKey path (account.ts).

import {
  keccak256,
  sha256,
  stringToBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";

// Fixed, forever-constant salt. It is part of the address derivation: changing
// it would change every PRF-derived address. Do not edit this string.
const PRF_SALT_STRING = "klarity.wallet.prf.v1";
const PRF_SALT: Uint8Array = hexToU8(sha256(stringToBytes(PRF_SALT_STRING)));

// Returns a Uint8Array backed by a plain ArrayBuffer (not SharedArrayBuffer) so
// it satisfies the DOM `BufferSource` used by WebAuthn allowCredentials ids.
function hexToU8(hex: Hex): Uint8Array<ArrayBuffer> {
  const h = hex.slice(2);
  const out = new Uint8Array(new ArrayBuffer(h.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64urlToU8(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function u8ToB64url(u8: Uint8Array): string {
  let bin = "";
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A PRF secret (32 bytes) → a deterministic private key → a local owner account.
// keccak256 keeps the value in the valid secp256k1 range in practice and gives a
// clean domain separation from the raw authenticator output.
export function ownerFromPrfSecret(secret: ArrayBuffer): LocalAccount {
  const bytes = new Uint8Array(secret);
  const pk = keccak256(bytes) as Hex;
  return privateKeyToAccount(pk);
}

export type PrfCreateResult = {
  id: string; // credential id (base64url)
  rawId: ArrayBuffer;
  publicKey: Hex | null; // COSE/P256 pubkey if we could extract it (for fallback)
  owner: LocalAccount; // PRF-derived owner (the source of truth)
};

// Create a new passkey WITH the PRF extension requested, then obtain its PRF
// secret and derive the owner. Returns null if the platform doesn't give us a
// usable PRF result (caller falls back to the P256 path).
export async function createPrfCredential(opts: {
  name: string;
  rpId?: string;
}): Promise<PrfCreateResult | null> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "Klarity", id: opts.rpId },
      user: { id: userId, name: opts.name, displayName: opts.name },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256 (P256)
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "preferred",
      },
      timeout: 60_000,
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return null;

  const ext = cred.getClientExtensionResults() as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
  };
  if (!ext.prf?.enabled) return null; // PRF not supported → fall back

  // create() often enables PRF but doesn't return results. Read the secret via a
  // scoped get() on the just-created credential.
  let secret = ext.prf.results?.first;
  if (!secret) {
    const got = await getPrfSecret({ id: cred.id, rpId: opts.rpId });
    if (!got) return null;
    secret = got;
  }

  const publicKey = extractP256PublicKey(cred);
  return {
    id: cred.id,
    rawId: cred.rawId,
    publicKey,
    owner: ownerFromPrfSecret(secret),
  };
}

// Obtain a PRF secret for a KNOWN credential id via a scoped get(). `eval` is not
// allowed on get(); `evalByCredential` keyed by the credential id is.
export async function getPrfSecret(opts: {
  id: string;
  rpId?: string;
}): Promise<ArrayBuffer | null> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const rawId = b64urlToU8(opts.id);
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ type: "public-key", id: rawId }],
      userVerification: "preferred",
      rpId: opts.rpId,
      timeout: 60_000,
      extensions: {
        prf: { evalByCredential: { [opts.id]: { first: PRF_SALT } } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) return null;
  const ext = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  return ext.prf?.results?.first ?? null;
}

// Show the OS picker (empty allowCredentials) to learn which passkey the user
// chose, then do a scoped get() to pull its PRF secret and derive the owner.
// Returns null if PRF isn't available for the chosen credential (caller falls
// back to the stored-publicKey path using the returned id).
export async function pickPrfCredential(opts: {
  rpId?: string;
}): Promise<{ id: string; owner: LocalAccount } | { id: string; owner: null } | null> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [], // empty → OS shows the full picker for this site
      userVerification: "preferred",
      rpId: opts.rpId,
      timeout: 60_000,
      extensions: {
        // Ask for the PRF secret on the picker get() itself. Chromium builds
        // that honour `eval` on an empty-allowlist get return it here, so the
        // common path needs no second prompt; others ignore it and we do a
        // scoped get() below.
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) return null;

  const id = assertion.id;
  const ext = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  // Picker didn't carry a PRF secret (expected: eval isn't allowed on an
  // empty-allowlist get). Do a scoped get() now that we know the id. This second
  // get() can fail (the user cancels the re-prompt, or the platform rejects two
  // back-to-back WebAuthn gets) — but the user HAS already chosen a passkey, so
  // we must keep the id and let the caller fall back by it rather than lose the
  // selection and report "no passkey selected".
  let secret = ext.prf?.results?.first ?? null;
  if (!secret) {
    try {
      secret = await getPrfSecret({ id, rpId: opts.rpId });
    } catch {
      secret = null;
    }
  }

  if (!secret) return { id, owner: null }; // no PRF → caller falls back by id
  return { id, owner: ownerFromPrfSecret(secret) };
}

// Best-effort extraction of the P256 public key from an attestation, so the
// fallback (stored-publicKey) path still has a key to persist. Returns null if
// it can't be parsed — the PRF owner is authoritative regardless.
function extractP256PublicKey(cred: PublicKeyCredential): Hex | null {
  try {
    const resp = cred.response as AuthenticatorAttestationResponse;
    const pk = resp.getPublicKey?.();
    if (!pk) return null;
    // SubjectPublicKeyInfo DER for P256 ends with the 65-byte 0x04||X||Y point.
    const der = new Uint8Array(pk);
    const marker = der.lastIndexOf(0x04);
    if (marker < 0 || der.length - marker < 65) return null;
    const point = der.slice(der.length - 65);
    if (point[0] !== 0x04) return null;
    return ("0x" + [...point.slice(1)].map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
  } catch {
    return null;
  }
}

export { PRF_SALT, u8ToB64url };
