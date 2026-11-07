import "./style.css";
import {
  makeAnonTransport,
  anonViemTransport,
  SPECIFIERS,
  type AnonTransport,
} from "./lib/anonTransport";
import {
  createPasskeyAccount,
  loadPasskeyAccount,
  loadStoredCredential,
  saveStoredCredential,
  clearStoredCredential,
  listPasskeys,
  pickPasskeyAccount,
  getPasskey,
  lastUsedPasskey,
  sendTransaction,
  bundlerUrl,
  CHAIN,
  type WalletAccount,
} from "./lib/account";
import { fetchContractHtml, mountDocument } from "./lib/hostRenderer";
import type { RpcRequest } from "./lib/providerBridge";
import { toHex } from "viem";

// Destination RPC for Base Sepolia (tunnelled through anon transport).
const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://sepolia.base.org";
// Which ERC-8244 contract serves the wallet UI. In dev we can also load the
// bundled local document (walletDocument.html) when no contract is set.
const WALLET_CONTRACT = import.meta.env.VITE_WALLET_CONTRACT as `0x${string}` | undefined;

const chainIdHex = toHex(CHAIN.id);

let anon: AnonTransport;
let wallet: WalletAccount | null = null;
// For PRF credentials we know the address (cached) without prompting, but the
// signing-capable account object requires a passkey get(). Track the cached
// address so boot can hydrate the UI read-only and defer the prompt until the
// user actually connects/signs.
let knownAddress: `0x${string}` | null = null;

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <header>
    <div class="brand">Klarity</div>
    <div class="origin" id="origin"></div>
  </header>
  <div class="status" id="status">booting…</div>
  <div class="frame" id="frame"></div>
  <div class="confirm" id="confirm" style="display:none"></div>
`;

const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const originEl = document.querySelector<HTMLDivElement>("#origin")!;
const frameEl = document.querySelector<HTMLDivElement>("#frame")!;
const confirmEl = document.querySelector<HTMLDivElement>("#confirm")!;

const setStatus = (s: string) => (statusEl.textContent = s);

// Reject a promise if it hasn't settled within ms. Used to bound anon-transport
// operations that can hang when a Tor gateway is down.
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
  ]);
}

// Host-rendered origin banner — OUTSIDE the sandboxed frame. The document
// cannot forge or overlay this (ERC-8244 anti-phishing requirement).
function renderOrigin(source: string) {
  originEl.innerHTML = `
    <span class="net">${CHAIN.name}</span>
    <span class="src" title="${source}">UI source: ${source}</span>
    <span class="anon ${anon.anonymous ? "on" : "off"}">${anon.anonymous ? "anon: Tor" : "anon: off (dev)"}</span>
  `;
}

// Host-side signing gate. Returns a Promise that resolves only on user approval.
function confirmAndSign(req: RpcRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!wallet) return reject(new Error("no account"));
    const tx = (req.params?.[0] ?? {}) as { to?: string; value?: string; data?: string };
    confirmEl.style.display = "block";
    confirmEl.innerHTML = `
      <div class="confirm-box">
        <div class="confirm-title">Confirm transaction</div>
        <div class="confirm-row"><span>From</span><span class="mono">${wallet.address}</span></div>
        <div class="confirm-row"><span>To</span><span class="mono">${tx.to ?? "—"}</span></div>
        <div class="confirm-row"><span>Value</span><span class="mono">${tx.value ? (Number(BigInt(tx.value)) / 1e18).toFixed(6) : "0"} ETH</span></div>
        <div class="confirm-row"><span>Network</span><span>${CHAIN.name}</span></div>
        <div class="confirm-actions">
          <button id="rejectBtn" class="ghost">Reject</button>
          <button id="approveBtn">Approve & sign with passkey</button>
        </div>
      </div>`;
    const cleanup = () => { confirmEl.style.display = "none"; confirmEl.innerHTML = ""; };
    document.querySelector("#rejectBtn")!.addEventListener("click", () => { cleanup(); reject(new Error("user rejected")); });
    document.querySelector("#approveBtn")!.addEventListener("click", async () => {
      cleanup();
      try {
        setStatus("signing with passkey & submitting userOp…");
        const { txHash } = await sendTransaction({
          transport: anonViemTransport(anon, RPC_URL, wallet!.address),
          bundlerTransport: anonViemTransport(anon, bundlerUrl(), wallet!.address),
          wallet: wallet!,
          to: tx.to as `0x${string}`,
          value: tx.value ? BigInt(tx.value) : 0n,
          data: (tx.data as `0x${string}`) ?? "0x",
        });
        setStatus("transaction landed: " + txHash);
        resolve(txHash);
      } catch (e) { reject(e as Error); }
    });
  });
}

// Read requests from the document → anon transport.
async function hostRpc(req: RpcRequest): Promise<unknown> {
  const t = anonViemTransport(anon, RPC_URL, wallet?.address);
  // Use a throwaway client-less request via the transport's request fn.
  const { request } = t({ chain: CHAIN, retryCount: 0 });
  return request({ method: req.method, params: req.params as any });
}

// eth_requestAccounts → load the last-used passkey if any, else create one.
async function ensureAccount(): Promise<string> {
  if (wallet) return wallet.address;
  const transport = anonViemTransport(anon, RPC_URL);
  const last = lastUsedPasskey();
  if (last) {
    // A passkey already exists → reuse it (stable address) instead of minting a
    // new one. This is what stops "a new address on every refresh". For PRF
    // credentials this prompts for the passkey (needed to derive the owner);
    // for legacy P256 it's offline.
    setStatus("loading your passkey account…");
    wallet = await loadPasskeyAccount(transport, last);
  } else {
    setStatus("creating passkey… approve the OS prompt");
    wallet = await createPasskeyAccount(transport);
    saveStoredCredential(wallet.credential);
  }
  knownAddress = wallet.address;
  setStatus("account ready: " + wallet.address);
  return wallet.address;
}

// Bring up the anon transport with a hard deadline. The tor-js specifier must
// bootstrap a Tor consensus through a gateway; if that gateway is down the
// bootstrap hangs indefinitely. We refuse to block boot on it: race readiness
// against a timeout, tear the dead worker down, and fall back to passthrough so
// the wallet still loads. The banner then tells the truth about what we got.
async function bringUpAnon(useTor: boolean): Promise<AnonTransport> {
  if (!useTor) {
    const t = makeAnonTransport({ specifier: SPECIFIERS.passthrough });
    await t.ready;
    return t;
  }
  setStatus("starting Tor transport… (bootstrapping relays, up to 90s)");
  const tor = makeAnonTransport({ specifier: SPECIFIERS.torJs });
  try {
    await withTimeout(tor.ready, 90_000, "Tor bootstrap timed out");
    return tor;
  } catch (e) {
    console.error("[boot] Tor transport failed, falling back to passthrough:", e);
    setStatus("Tor gateway unreachable — falling back to direct (not anonymous)");
    try { tor.close(); } catch { /* ignore */ }
    const t = makeAnonTransport({ specifier: SPECIFIERS.passthrough });
    await t.ready;
    return t;
  }
}

async function boot() {
  // Dev default: passthrough specifier (not anonymous) so it runs without Tor.
  // VITE_USE_TOR=1 asks for real Tor, but bringUpAnon degrades gracefully if the
  // gateway is dead rather than hanging boot forever.
  const useTor = import.meta.env.VITE_USE_TOR === "1";
  anon = await bringUpAnon(useTor);

  // Re-derive the saved account so the SAME counterfactual address appears on
  // every refresh. Two cases:
  //   - Legacy P256 credential: derive offline from the stored public key (no
  //     prompt) and keep the fully-live wallet.
  //   - PRF credential: deriving the owner needs a passkey get() (a prompt). We
  //     must NOT prompt on every reload, so we only surface the CACHED address
  //     (knownAddress) read-only and defer the real derivation to the first
  //     connect/sign via ensureAccount(). Without a cached address we drop to
  //     onboarding (a fresh pick still recovers via PRF).
  const stored = loadStoredCredential();
  if (stored) {
    if (stored.kind === "prf") {
      if (stored.address) {
        knownAddress = stored.address;
      }
    } else {
      try {
        wallet = await loadPasskeyAccount(anonViemTransport(anon, RPC_URL), stored);
        knownAddress = wallet.address;
      } catch (e) {
        // Don't swallow this: if a stored credential fails to re-derive, the UI
        // drops to onboarding and a fresh "Create" mints a NEW address — which
        // looks exactly like "a new address on every refresh". Surface it so the
        // cause (corrupt stored key, cleared storage, viem mismatch) is visible.
        console.error("[boot] stored credential failed to load:", e);
        setStatus("saved account could not be restored — see console");
      }
    }
  }

  // Load the wallet UI document: from the ERC-8244 contract if configured,
  // else the bundled local document (dev).
  let doc: string;
  let source: string;
  if (WALLET_CONTRACT) {
    setStatus("fetching wallet UI from contract via anon transport…");
    try {
      doc = await withTimeout(
        fetchContractHtml(anon.fetch, RPC_URL, WALLET_CONTRACT),
        30_000,
        "contract fetch timed out",
      );
      source = WALLET_CONTRACT;
    } catch (e) {
      // The contract fetch rides the anon transport. If Tor bootstrapped but
      // can't actually carry traffic, this is where it stalls — so cap it and
      // fall back to the bundled document rather than leaving a blank page.
      console.error("[boot] contract fetch via anon failed, using bundled document:", e);
      setStatus("contract fetch failed — serving bundled UI (see console)");
      doc = (await import("./walletDocument.html?raw")).default;
      source = "bundled dev document (contract unreachable)";
    }
  } else {
    doc = (await import("./walletDocument.html?raw")).default;
    source = "bundled dev document";
  }
  renderOrigin(source);

  // Mount the document sandboxed, with the provider bridge.
  mountDocument({
    container: frameEl,
    doc,
    chainIdHex,
    address: "", // filled after account creation; doc calls eth_requestAccounts
    handlers: {
      rpc: async (req) => {
        if (req.method === "eth_requestAccounts" || req.method === "eth_accounts") {
          // eth_accounts is a passive read: never prompt. If we have a live
          // wallet, report it; else report the cached PRF address (hydrated at
          // boot) so the UI shows "connected" read-only until the user acts.
          if (req.method === "eth_accounts") {
            if (wallet) return [wallet.address];
            return knownAddress ? [knownAddress] : [];
          }
          // eth_requestAccounts is the explicit connect: derive the live wallet
          // now (this is where a PRF credential finally prompts for the passkey).
          if (!wallet) await ensureAccount();
          return wallet ? [wallet.address] : [];
        }
        return hostRpc(req);
      },
      confirmAndSign,
      listPasskeys: () =>
        listPasskeys().map((p) => ({
          id: p.id,
          address: p.address ?? "",
          label: p.label ?? "Passkey",
        })),
      selectPasskey: async (id: string) => {
        const t = anonViemTransport(anon, RPC_URL);
        if (id === "__pick__") {
          // Empty-allowlist OS picker: the user chooses among the passkeys the
          // OS holds for this site. We map the chosen id back to a stored public
          // key to re-derive the same address (see pickPasskeyAccount).
          wallet = await pickPasskeyAccount(t);
        } else {
          // Selecting a specific passkey by id. Normally it's in our registry
          // (the list rows come from there). But a PRF credential picked earlier
          // on another device/profile, or one listed before the registry write
          // landed, may be absent — don't hard-fail with "unknown passkey".
          // Re-derive it as a PRF credential straight from its id (a scoped get()
          // yields the PRF secret → the SAME address); loadPasskeyAccount records
          // it to the registry and marks it last-used.
          const known = getPasskey(id) ?? {
            id,
            publicKey: "0x" as const,
            kind: "prf" as const,
          };
          wallet = await loadPasskeyAccount(t, known);
        }
        setStatus("account ready: " + wallet.address);
        return wallet.address;
      },
      createPasskey: async (name: string) => {
        // Mint a brand-new passkey under the user-chosen label. Unlike
        // ensureAccount's fallback (which uses the default "Klarity" name), this
        // records a distinguishable registry entry so multiple passkeys don't
        // collapse into one.
        const t = anonViemTransport(anon, RPC_URL);
        wallet = await createPasskeyAccount(t, name);
        saveStoredCredential(wallet.credential);
        setStatus("account ready: " + wallet.address);
        return wallet.address;
      },
      disconnect: () => {
        // Drop the account: clear the stored passkey and null host state so the
        // next eth_accounts returns [] and the document shows onboarding. The
        // on-chain counterfactual account (if deployed) is untouched — this only
        // forgets the credential on THIS device.
        clearStoredCredential();
        wallet = null;
        setStatus("disconnected — connect again to restore your account");
        return true;
      },
    },
  });

  setStatus("ready — open the wallet below");
}

boot().catch((e) => setStatus("boot failed: " + (e as Error).message));
