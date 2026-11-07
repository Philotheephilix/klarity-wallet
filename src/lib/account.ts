// Passkey smart-account layer.
//
// The entire account is viem's account-abstraction module:
//   createWebAuthnCredential -> makes a passkey (navigator.credentials.create)
//   toWebAuthnAccount        -> wraps it as a signer (owner)
//   toCoinbaseSmartAccount   -> Coinbase Smart Wallet, counterfactual address
//                               computed locally via CREATE2 (NO deploy, NO rpc)
//   createBundlerClient      -> submits the ERC-4337 userOp
//
// The account is counterfactual: its address exists from the passkey public key
// alone, before any on-chain write. Creation is therefore fully offline and
// anonymous — the chain is only touched on the first real transaction, when the
// bundler deploys the account as part of the userOp.
//
// All chain reads use a viem client whose transport can be the anon transport,
// so balance/nonce reads ride Tor too. The bundler POST is tunnelled through the
// same anon fetch.

import {
  createPublicClient,
  http,
  type Chain,
  type PublicClient,
  type Transport,
  type LocalAccount,
  formatEther,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  createWebAuthnCredential,
  toWebAuthnAccount,
  toCoinbaseSmartAccount,
  createBundlerClient,
  type P256Credential,
} from "viem/account-abstraction";
import {
  createPrfCredential,
  pickPrfCredential,
  getPrfSecret,
  ownerFromPrfSecret,
} from "./prf";

export const CHAIN: Chain = baseSepolia;

// Persisted passkey handle — enough to re-derive the same account next session.
// `kind` records how the owner is derived:
//   "prf"  — owner comes from the WebAuthn PRF secret (recoverable on any synced
//            device; publicKey/address are cached only for display/fallback).
//   "p256" — legacy path: owner is the stored P256 public key (recoverable only
//            where that public key was stored).
export type StoredCredential = {
  id: string;
  publicKey: `0x${string}`;
  label?: string;
  address?: `0x${string}`;
  createdAt?: number;
  kind?: "prf" | "p256";
};

// WebAuthn deliberately gives a web page NO way to enumerate the user's
// passkeys (privacy). So we keep our own registry of every passkey this wallet
// has minted: id -> {publicKey, address, label}. That lets us (a) list them for
// the user and (b) map a passkey the OS picker returns (which yields only an id)
// back to its public key, so we re-derive the SAME address instead of a new one.
const REGISTRY_KEY = "klarity.wallet.passkeys";
// Which passkey id was used last — auto-selected on boot for convenience.
const LAST_KEY = "klarity.wallet.lastPasskey";

type Registry = Record<string, StoredCredential>;

function readRegistry(): Registry {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    return raw ? (JSON.parse(raw) as Registry) : {};
  } catch {
    return {};
  }
}

function writeRegistry(reg: Registry) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
}

// All passkeys this wallet knows about, newest first. This is "list all
// passkeys" — bounded to ones we minted, which is all a web page may ever know.
export function listPasskeys(): StoredCredential[] {
  return Object.values(readRegistry()).sort(
    (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
}

export function rememberPasskey(c: StoredCredential) {
  const reg = readRegistry();
  reg[c.id] = { ...reg[c.id], ...c };
  writeRegistry(reg);
  localStorage.setItem(LAST_KEY, c.id);
}

export function getPasskey(id: string): StoredCredential | null {
  return readRegistry()[id] ?? null;
}

export function forgetPasskey(id: string) {
  const reg = readRegistry();
  delete reg[id];
  writeRegistry(reg);
  if (localStorage.getItem(LAST_KEY) === id) localStorage.removeItem(LAST_KEY);
}

// The passkey to auto-load on boot (last used, else newest, else none).
export function lastUsedPasskey(): StoredCredential | null {
  const id = localStorage.getItem(LAST_KEY);
  if (id) {
    const hit = getPasskey(id);
    if (hit) return hit;
  }
  return listPasskeys()[0] ?? null;
}

// Back-compat single-credential accessors, now backed by the registry.
export function loadStoredCredential(): StoredCredential | null {
  return lastUsedPasskey();
}

export function saveStoredCredential(c: StoredCredential) {
  rememberPasskey(c);
}

export function clearStoredCredential() {
  // "Disconnect" forgets the last-used selection but KEEPS the registry so the
  // user can pick the passkey again. Use forgetPasskey(id) to truly drop one.
  localStorage.removeItem(LAST_KEY);
}

export type WalletAccount = {
  address: `0x${string}`;
  account: Awaited<ReturnType<typeof toCoinbaseSmartAccount>>;
  credential: StoredCredential;
};

function publicClientWith(transport: Transport): PublicClient {
  return createPublicClient({ chain: CHAIN, transport });
}

// Create a brand-new passkey and derive its counterfactual smart account.
// Browser-only: triggers the OS passkey prompt. Prefers the PRF path (owner
// derived from the authenticator's PRF secret → recoverable on any synced
// device). Falls back to the legacy P256 path when PRF is unavailable. The new
// passkey is recorded in the registry so it shows up in listPasskeys().
export async function createPasskeyAccount(transport: Transport, name = "Klarity"): Promise<WalletAccount> {
  const rpId = typeof window !== "undefined" ? window.location.hostname : undefined;

  // PRF path (preferred).
  try {
    const prf = await createPrfCredential({ name, rpId });
    if (prf) {
      const wallet = await buildAccountFromOwner(transport, prf.owner, {
        id: prf.id,
        publicKey: prf.publicKey ?? "0x",
        kind: "prf",
      });
      rememberPasskey({
        ...wallet.credential,
        label: name,
        address: wallet.address,
        createdAt: Date.now(),
      });
      return wallet;
    }
  } catch (e) {
    // PRF create failed (unsupported extension, user cancel on the 2nd get, …).
    // Fall through to the legacy path rather than leaving the user stuck.
    console.warn("[account] PRF create unavailable, using P256 path:", e);
  }

  // Legacy P256 path.
  const credential = await createWebAuthnCredential({ name });
  const wallet = await buildAccount(transport, credential);
  rememberPasskey({
    ...wallet.credential,
    label: name,
    address: wallet.address,
    kind: "p256",
    createdAt: Date.now(),
  });
  return wallet;
}

// Let the user PICK an existing passkey via the OS picker. Tries PRF first: the
// picker returns the chosen id, and a scoped get() yields the PRF secret →
// owner → the SAME address, even if this device never stored anything about it.
// Falls back to the stored-publicKey map only when PRF is unavailable AND we
// happen to hold the public key. Throws the clear "unknown passkey" error only
// in the genuinely unrecoverable case.
export async function pickPasskeyAccount(transport: Transport): Promise<WalletAccount> {
  const rpId = typeof window !== "undefined" ? window.location.hostname : undefined;

  let picked: Awaited<ReturnType<typeof pickPrfCredential>> = null;
  try {
    picked = await pickPrfCredential({ rpId });
  } catch (e) {
    console.warn("[account] PRF pick failed:", e);
  }

  if (picked && picked.owner) {
    const known = getPasskey(picked.id);
    const wallet = await buildAccountFromOwner(transport, picked.owner, {
      id: picked.id,
      publicKey: known?.publicKey ?? "0x",
      kind: "prf",
    });
    rememberPasskey({
      ...(known ?? {}),
      id: picked.id,
      publicKey: known?.publicKey ?? "0x",
      label: known?.label ?? "Passkey",
      address: wallet.address,
      kind: "prf",
    });
    return wallet;
  }

  // No PRF secret — fall back to the stored public key for the chosen id.
  const pickedId = picked?.id;
  if (!pickedId) throw new Error("no passkey selected");
  const known = getPasskey(pickedId);
  if (!known || !known.publicKey || known.publicKey === "0x") {
    throw new Error(
      "That passkey isn't recoverable on this device — it predates PRF support and its public key was never stored here. Create a new one (new passkeys are recoverable on any of your devices).",
    );
  }
  const wallet = await buildAccount(transport, known as unknown as P256Credential);
  rememberPasskey({ ...known, address: wallet.address, kind: "p256" });
  return wallet;
}

// Re-derive an existing account from a stored credential (for auto-load on boot
// and selecting a known passkey by id). PRF-kind credentials re-derive via a
// scoped get() (prompts for the passkey); P256-kind re-derive offline from the
// stored public key (no prompt).
export async function loadPasskeyAccount(transport: Transport, stored: StoredCredential): Promise<WalletAccount> {
  const rpId = typeof window !== "undefined" ? window.location.hostname : undefined;

  if (stored.kind === "prf") {
    const secret = await getPrfSecret({ id: stored.id, rpId });
    if (!secret) throw new Error("could not read the passkey — try again or pick it from the list");
    const owner = ownerFromPrfSecret(secret);
    const wallet = await buildAccountFromOwner(transport, owner, {
      id: stored.id,
      publicKey: stored.publicKey,
      kind: "prf",
    });
    rememberPasskey({ ...stored, address: wallet.address, kind: "prf" });
    return wallet;
  }

  const wallet = await buildAccount(transport, stored as unknown as P256Credential);
  rememberPasskey({ ...stored, address: wallet.address, kind: stored.kind ?? "p256" });
  return wallet;
}

// Build a smart account from an explicit local owner (the PRF path). The owner
// is a plain private-key account derived from the PRF secret — Coinbase Smart
// Wallet accepts a local owner directly.
async function buildAccountFromOwner(
  transport: Transport,
  owner: LocalAccount,
  meta: { id: string; publicKey: `0x${string}`; kind: "prf" | "p256" },
): Promise<WalletAccount> {
  const client = publicClientWith(transport);
  const account = await toCoinbaseSmartAccount({
    client,
    owners: [owner],
    version: "1.1",
  });
  const stored: StoredCredential = {
    id: meta.id,
    publicKey: meta.publicKey,
    kind: meta.kind,
  };
  return { address: account.address, account, credential: stored };
}

async function buildAccount(transport: Transport, credential: P256Credential | StoredCredential): Promise<WalletAccount> {
  const client = publicClientWith(transport);
  const owner = toWebAuthnAccount({
    credential: credential as P256Credential,
    rpId: typeof window !== "undefined" ? window.location.hostname : undefined,
  });
  const account = await toCoinbaseSmartAccount({
    client,
    owners: [owner],
    version: "1.1",
  });
  const stored: StoredCredential = {
    id: (credential as P256Credential).id,
    publicKey: (credential as P256Credential).publicKey,
    kind: "p256",
  };
  return { address: account.address, account, credential: stored };
}

export async function getBalance(transport: Transport, address: `0x${string}`): Promise<{ wei: bigint; eth: string }> {
  const client = publicClientWith(transport);
  const wei = await client.getBalance({ address });
  return { wei, eth: formatEther(wei) };
}

export async function isDeployed(transport: Transport, address: `0x${string}`): Promise<boolean> {
  const client = publicClientWith(transport);
  const code = await client.getCode({ address });
  return !!code && code !== "0x";
}

// Send a transaction as an ERC-4337 userOp. transport reads chain state; the
// bundler transport submits the userOp (both can be anon). Returns the tx hash.
export async function sendTransaction(params: {
  transport: Transport;
  bundlerTransport: Transport;
  wallet: WalletAccount;
  to: `0x${string}`;
  value: bigint;
  data?: `0x${string}`;
}): Promise<{ userOpHash: `0x${string}`; txHash: `0x${string}` }> {
  // Sending requires an ERC-4337 bundler. Without an API key the Pimlico v2
  // endpoint returns 401, which viem surfaces as the opaque "string did not
  // match the expected pattern" parse error. Fail loudly and clearly instead so
  // the real cause (no bundler configured) is obvious.
  if (!bundlerConfigured()) {
    throw new Error(
      "Can't send: no transaction bundler is configured. Set VITE_PIMLICO_KEY " +
        "(free key from dashboard.pimlico.io for " + CHAIN.name + ") and rebuild.",
    );
  }
  const client = publicClientWith(params.transport);
  const bundler = createBundlerClient({
    account: params.wallet.account,
    client,
    transport: params.bundlerTransport,
    // Pimlico rejects userOps priced off the public mempool's base fee. Use the
    // bundler's own gas oracle (pimlico_getUserOperationGasPrice) so the op is
    // priced at a level the bundler will accept.
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        const { standard } = (await bundlerClient.request({
          // @ts-expect-error pimlico method not in viem's union
          method: "pimlico_getUserOperationGasPrice",
        })) as { standard: { maxFeePerGas: `0x${string}`; maxPriorityFeePerGas: `0x${string}` } };
        return {
          maxFeePerGas: BigInt(standard.maxFeePerGas),
          maxPriorityFeePerGas: BigInt(standard.maxPriorityFeePerGas),
        };
      },
    },
  });
  let userOpHash: `0x${string}`;
  try {
    userOpHash = await bundler.sendUserOperation({
      account: params.wallet.account,
      calls: [{ to: params.to, value: params.value, data: params.data ?? "0x" }],
    });
  } catch (e) {
    // A non-hex bundler response (401/HTML/error JSON) trips viem's quantity/hex
    // validators with "The string did not match the expected pattern." Translate
    // that class of error into a cause the user can act on.
    const msg = (e as Error)?.message ?? "";
    if (/did not match the expected pattern|Unauthorized|401|apikey/i.test(msg)) {
      throw new Error(
        "Bundler rejected the request — the API key may be missing, invalid, or " +
          "out of quota. Check VITE_PIMLICO_KEY for " + CHAIN.name + ".",
      );
    }
    throw e;
  }
  const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
  return { userOpHash, txHash: receipt.receipt.transactionHash };
}

// The Pimlico bundler URL for Base Sepolia (free key via env). Exposed so the
// caller can tunnel the userOp POST through the anon transport.
export function bundlerUrl(): string {
  const key = import.meta.env.VITE_PIMLICO_KEY ?? "";
  return `https://api.pimlico.io/v2/${CHAIN.id}/rpc${key ? `?apikey=${key}` : ""}`;
}

// Whether a bundler API key is present. Sends are impossible without one.
export function bundlerConfigured(): boolean {
  return !!(import.meta.env.VITE_PIMLICO_KEY ?? "").trim();
}

// Build a plain (clearnet) bundler transport. Prefer tunnelling bundlerUrl()
// through the anon transport instead — see main.ts.
export function bundlerHttpTransport(): Transport {
  return http(bundlerUrl());
}
