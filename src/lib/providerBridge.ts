// Provider bridge: the protocol between the host (trusted, holds the account +
// anon transport) and the sandboxed iframe (untrusted ERC-8244 document).
//
// The document inside the iframe gets an injected EIP-1193 provider
// (window.ethereum). Every request is postMessage'd to the host. The host:
//   - answers read methods (eth_call, eth_chainId, balance...) via anon transport
//   - GATES every signing/sending method through an explicit host-rendered
//     confirmation outside the iframe (the document can never bypass this)
//
// This is the ERC-8244 security model: the document is untrusted code; the host
// renders origin + chainId outside the frame, and no signature leaves without a
// host-side human confirm.

export type RpcRequest = { method: string; params?: unknown[] };

export const BRIDGE_REQUEST = "erc8244:rpc:request";
export const BRIDGE_RESPONSE = "erc8244:rpc:response";

export type BridgeRequestMsg = {
  type: typeof BRIDGE_REQUEST;
  id: number;
  request: RpcRequest;
};

export type BridgeResponseMsg = {
  type: typeof BRIDGE_RESPONSE;
  id: number;
  result?: unknown;
  error?: { message: string };
};

// Methods that MUST go through host confirmation (never auto-answered).
export const SIGNING_METHODS = new Set<string>([
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "wallet_sendCalls",
]);

// The script injected INTO the document (runs inside the sandboxed iframe).
// Must be fully self-contained — it becomes a string embedded in the frame.
export function providerInjectionScript(chainIdHex: string, originAddress: string): string {
  return `
(() => {
  let _id = 1;
  const pending = new Map();
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.type !== ${JSON.stringify(BRIDGE_RESPONSE)}) return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  });
  const request = (args) => new Promise((resolve, reject) => {
    const id = _id++;
    pending.set(id, { resolve, reject });
    parent.postMessage({ type: ${JSON.stringify(BRIDGE_REQUEST)}, id, request: { method: args.method, params: args.params || [] } }, "*");
  });
  const provider = {
    isKlarityWallet: true,
    chainId: ${JSON.stringify(chainIdHex)},
    selectedAddress: ${JSON.stringify(originAddress)},
    request,
    on: () => {},
    removeListener: () => {},
  };
  window.ethereum = provider;
  // EIP-6963 announce
  const info = { uuid: crypto.randomUUID(), name: "Klarity", icon: "data:image/svg+xml,", rdns: "eth.klarity" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
`;
}

// Non-standard control method the document uses to drop the connected account.
// It touches host-only state (the stored credential lives in host localStorage,
// unreachable from the null-origin frame), so it must round-trip through the
// bridge rather than being handled inside the document.
export const DISCONNECT_METHOD = "wallet_disconnect";

// List the passkeys this wallet knows about (host-side registry). Returns an
// array of { id, address, label }. WebAuthn can't enumerate OS passkeys, so
// this is our own record of ones created here.
export const LIST_PASSKEYS_METHOD = "wallet_listPasskeys";

// Select a passkey by id (params: [id]) and make it the active account. The id
// "__pick__" means: show the OS passkey picker and let the user choose. Any
// other id loads that specific known passkey directly. Returns the address.
export const SELECT_PASSKEY_METHOD = "wallet_selectPasskey";

// Create a NEW passkey with a user-chosen label (params: [name]). The document
// collects the name inline (window.prompt is blocked in the null-origin frame)
// and passes it here so the registry entry is distinguishable instead of always
// defaulting to "Klarity". Returns the new account address.
export const CREATE_PASSKEY_METHOD = "wallet_createPasskey";

// Host-side handler factory. Caller supplies:
//   - rpc: forwards a read request through the anon transport
//   - confirmAndSign: shows host UI, and if approved performs the signing method
//   - disconnect: clears the stored credential + host account state (optional)
//   - listPasskeys: returns the known-passkey registry (optional)
//   - selectPasskey: activate a passkey by id, or "__pick__" for the OS picker
export type HostHandlers = {
  rpc: (req: RpcRequest) => Promise<unknown>;
  confirmAndSign: (req: RpcRequest) => Promise<unknown>;
  disconnect?: () => Promise<unknown> | unknown;
  listPasskeys?: () => Promise<unknown> | unknown;
  selectPasskey?: (id: string) => Promise<unknown> | unknown;
  createPasskey?: (name: string) => Promise<unknown> | unknown;
  chainIdHex: string;
  address: string;
};

export function makeBridgeListener(handlers: HostHandlers, frameWindow: () => Window | null) {
  return async (e: MessageEvent) => {
    const m = e.data as BridgeRequestMsg;
    if (!m || m.type !== BRIDGE_REQUEST) return;
    const reply = (r: Partial<BridgeResponseMsg>) =>
      frameWindow()?.postMessage({ type: BRIDGE_RESPONSE, id: m.id, ...r }, "*");
    try {
      const { method, params } = m.request;
      if (method === "eth_chainId") return reply({ result: handlers.chainIdHex });
      if (method === DISCONNECT_METHOD) {
        const result = handlers.disconnect ? await handlers.disconnect() : null;
        return reply({ result: result ?? true });
      }
      if (method === LIST_PASSKEYS_METHOD) {
        const result = handlers.listPasskeys ? await handlers.listPasskeys() : [];
        return reply({ result });
      }
      if (method === SELECT_PASSKEY_METHOD) {
        if (!handlers.selectPasskey) throw new Error("passkey selection unavailable");
        const id = (params?.[0] as string) ?? "__pick__";
        const result = await handlers.selectPasskey(id);
        return reply({ result });
      }
      if (method === CREATE_PASSKEY_METHOD) {
        if (!handlers.createPasskey) throw new Error("passkey creation unavailable");
        const name = ((params?.[0] as string) ?? "").trim();
        if (!name) throw new Error("a name is required to create a passkey");
        const result = await handlers.createPasskey(name);
        return reply({ result });
      }
      if (SIGNING_METHODS.has(method)) {
        const result = await handlers.confirmAndSign(m.request);
        return reply({ result });
      }
      const result = await handlers.rpc(m.request);
      reply({ result });
    } catch (err) {
      reply({ error: { message: (err as Error).message } });
    }
  };
}
