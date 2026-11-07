// anon-rpc transport layer.
//
// Wraps the browser-only AnonRpcWorker. The worker runs the anonymizing client
// (Tor / Nym) inside its own null-origin sandboxed iframe + Web Worker — the
// host constructs it and does nothing else. `worker.fetch` is a WHATWG fetch
// that tunnels the request through the chosen anonymizing network to ANY
// destination URL we pass (the specifier picks the network, not the target).
//
// We expose two things:
//   makeAnonTransport()  -> a viem `custom` transport whose eth_calls ride anon
//   rawAnonFetch()       -> the bound fetch, for tunnelling a bundler POST
//
// The specifier is read ONCE at startup via preExisting.rpcProvider. For the
// "indestructible" goal that bootstrap read must not depend on a live clearnet
// RPC, so we answer it from a LOCAL passthrough by default (dev), and allow a
// real provider to be injected in production.

import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { custom, type EIP1193RequestFn } from "viem";

export type SpecifierProfile = {
  label: string;
  address: `0x${string}`;
  config?: unknown;
  anonymous: boolean;
};

// Real deployed specifiers (from anon-rpc adopters.json5, SPEC 0.4.0).
export const SPECIFIERS: Record<string, SpecifierProfile> = {
  // dev default: passes through, NOT anonymous — lets everything run without Tor.
  passthrough: {
    label: "passthrough (dev, not anonymous)",
    address: "0x4fd77be300f31c5fe6ab266d35d27750a3478d27",
    anonymous: false,
  },
  // real Tor. gateway is operator-run (mcp.philotheephilix.in); override if it moves.
  torJs: {
    label: "tor-js (real Tor)",
    address: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
    config: {
      gateways: [
        "161.118.166.4:12298:uEiC7vWc1fxm8QL4ScIBWbGWMLdYb5RdCqn8h8CGLH0nevQ",
      ],
    },
    anonymous: true,
  },
  // Nym mixnet.
  nym: {
    label: "nym (mixnet)",
    address: "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0",
    anonymous: true,
  },
};

export type AnonTransportOptions = {
  specifier?: SpecifierProfile;
  // provider used ONCE to read the specifier contract. Default: a local
  // passthrough to a public RPC (dev). Production should pass a bundled/local one.
  bootstrapRpcUrl?: string;
  isolationKey?: string;
};

// The bound fetch the worker exposes.
export type AnonFetch = (url: string, init: RequestInit & { anonOptions?: { isolationKey?: string } }) => Promise<Response>;

export type AnonTransport = {
  worker: AnonRpcWorker;
  fetch: AnonFetch;
  ready: Promise<void>;
  close: () => void;
  anonymous: boolean;
};

const DEFAULT_BOOTSTRAP_RPC = "https://ethereum-rpc.publicnode.com";

// Minimal EIP-1193 provider that answers the one-time specifier read from a
// plain RPC. In the real wallet this is replaced by a local/bundled answerer so
// no clearnet call is ever made (kills anon-rpc's only non-anon bootstrap hop).
function makeBootstrapProvider(rpcUrl: string) {
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    },
  };
}

export function makeAnonTransport(opts: AnonTransportOptions = {}): AnonTransport {
  const specifier = opts.specifier ?? SPECIFIERS.passthrough;
  const bootstrapRpcUrl = opts.bootstrapRpcUrl ?? DEFAULT_BOOTSTRAP_RPC;

  const worker = new AnonRpcWorker({
    address: specifier.address,
    config: specifier.config,
    preExisting: { rpcProvider: makeBootstrapProvider(bootstrapRpcUrl) },
  } as ConstructorParameters<typeof AnonRpcWorker>[0]);

  const anonFetch: AnonFetch = (url, init) => worker.fetch(url, init);

  return {
    worker,
    fetch: anonFetch,
    ready: (worker as unknown as { ready: Promise<void> }).ready ?? Promise.resolve(),
    close: () => worker.close?.(),
    anonymous: specifier.anonymous,
  };
}

// A viem custom transport that sends every JSON-RPC request through the anon
// worker to the given destination RPC URL. Used for both chain reads and the
// ERC-4337 bundler POST, so NO JSON-RPC ever leaves over clearnet.
export function anonViemTransport(anon: AnonTransport, rpcUrl: string, isolationKey?: string) {
  const request: EIP1193RequestFn = async ({ method, params }) => {
    const res = await anon.fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] }),
      anonOptions: isolationKey ? { isolationKey } : undefined,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? "rpc error");
    return json.result;
  };
  return custom({ request });
}
