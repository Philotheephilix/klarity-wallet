// ERC-8244 host renderer.
//
// 1. Fetches html() from the target contract through the anon transport.
// 2. Injects the EIP-1193 provider bridge script into the document.
// 3. Mounts it in a sandboxed iframe (sandbox="allow-scripts" — NO
//    allow-same-origin, so the document is null-origin and cannot touch host
//    cookies/localStorage or script the parent).
// 4. Wires the postMessage bridge so reads ride anon and signs are gated.
//
// Security per ERC-8244: the document is untrusted. Origin address + chain id
// are rendered by the HOST, outside the frame, where the document cannot forge
// them. Top-level navigation from inside the frame is blocked (no
// allow-top-navigation).

import { decodeAbiParameters, parseAbiParameters, encodeFunctionData } from "viem";
import {
  makeBridgeListener,
  providerInjectionScript,
  type HostHandlers,
  type RpcRequest,
} from "./providerBridge";

const HTML_SELECTOR = "0x33c34ac3"; // bytes4(keccak256("html()"))

// Fetch html() via a raw eth_call through the anon transport.
export async function fetchContractHtml(
  anonFetch: (url: string, init: RequestInit & { anonOptions?: { isolationKey?: string } }) => Promise<Response>,
  rpcUrl: string,
  contract: `0x${string}`,
): Promise<string> {
  const res = await anonFetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: contract, data: HTML_SELECTOR }, "latest"],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  const raw = json.result as `0x${string}`;
  if (!raw || raw === "0x") throw new Error("html() returned empty — not an ERC-8244 contract");
  const [doc] = decodeAbiParameters(parseAbiParameters("string"), raw);
  return doc as string;
}

// Splice the provider injection into the document <head> (or prepend if absent).
export function injectProvider(doc: string, chainIdHex: string, originAddress: string): string {
  const script = `<script>${providerInjectionScript(chainIdHex, originAddress)}</script>`;
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head([^>]*)>/i, `<head$1>${script}`);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html([^>]*)>/i, `<html$1>${script}`);
  return script + doc;
}

export type MountOptions = {
  container: HTMLElement;
  doc: string;
  chainIdHex: string;
  address: string;
  handlers: Omit<HostHandlers, "chainIdHex" | "address">;
};

export function mountDocument(opts: MountOptions): { iframe: HTMLIFrameElement; teardown: () => void } {
  const injected = injectProvider(opts.doc, opts.chainIdHex, opts.address);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts"); // null-origin, scripts only
  iframe.style.width = "100%";
  iframe.style.height = "100%";
  iframe.style.border = "0";
  iframe.srcdoc = injected;

  const handlers: HostHandlers = {
    ...opts.handlers,
    chainIdHex: opts.chainIdHex,
    address: opts.address,
  };
  const listener = makeBridgeListener(handlers, () => iframe.contentWindow);
  window.addEventListener("message", listener);

  opts.container.innerHTML = "";
  opts.container.appendChild(iframe);

  return {
    iframe,
    teardown: () => {
      window.removeEventListener("message", listener);
      iframe.remove();
    },
  };
}

// Helper exposed for the wallet UI document to encode a contract call (used by
// the served dapp when it wants the host to send a tx).
export function encodeCall(abi: Parameters<typeof encodeFunctionData>[0]["abi"], functionName: string, args: unknown[]) {
  return encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
}

export type { RpcRequest };
