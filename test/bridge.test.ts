import { describe, it, expect, vi } from "vitest";
import { makeBridgeListener, BRIDGE_REQUEST, BRIDGE_RESPONSE } from "../src/lib/providerBridge";

// Verifies the host-side bridge routes correctly: reads -> rpc, signs ->
// confirmAndSign, and a signing request NEVER reaches the plain rpc path.
describe("bridge listener routing", () => {
  function setup() {
    const posted: any[] = [];
    const fakeFrame = { postMessage: (msg: any) => posted.push(msg) } as unknown as Window;
    const rpc = vi.fn(async () => "0xRPC_RESULT");
    const confirmAndSign = vi.fn(async () => "0xSIGNED");
    const listener = makeBridgeListener(
      { rpc, confirmAndSign, chainIdHex: "0x14a34", address: "0xWALLET" },
      () => fakeFrame,
    );
    const send = (request: any, id = 1) =>
      listener({ data: { type: BRIDGE_REQUEST, id, request } } as MessageEvent);
    return { posted, rpc, confirmAndSign, send };
  }

  it("answers eth_chainId locally without rpc or sign", async () => {
    const { posted, rpc, confirmAndSign, send } = setup();
    await send({ method: "eth_chainId", params: [] });
    expect(rpc).not.toHaveBeenCalled();
    expect(confirmAndSign).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ type: BRIDGE_RESPONSE, id: 1, result: "0x14a34" });
  });

  it("routes read methods to rpc", async () => {
    const { posted, rpc, confirmAndSign, send } = setup();
    await send({ method: "eth_getBalance", params: ["0xWALLET", "latest"] });
    expect(rpc).toHaveBeenCalledOnce();
    expect(confirmAndSign).not.toHaveBeenCalled();
    expect(posted[0].result).toBe("0xRPC_RESULT");
  });

  it("routes signing methods to confirmAndSign, NEVER to rpc", async () => {
    const { posted, rpc, confirmAndSign, send } = setup();
    await send({ method: "eth_sendTransaction", params: [{ to: "0xdead", value: "0x1" }] });
    expect(confirmAndSign).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
    expect(posted[0].result).toBe("0xSIGNED");
  });

  it("surfaces a rejected signature as an error to the document", async () => {
    const { posted } = (() => {
      const posted: any[] = [];
      const fakeFrame = { postMessage: (m: any) => posted.push(m) } as unknown as Window;
      const listener = makeBridgeListener(
        {
          rpc: async () => "x",
          confirmAndSign: async () => { throw new Error("user rejected"); },
          chainIdHex: "0x1",
          address: "0xA",
        },
        () => fakeFrame,
      );
      listener({ data: { type: BRIDGE_REQUEST, id: 7, request: { method: "eth_sendTransaction", params: [{}] } } } as MessageEvent);
      return { posted };
    })();
    // allow the async reject to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(posted[0]).toMatchObject({ type: BRIDGE_RESPONSE, id: 7 });
    expect(posted[0].error.message).toBe("user rejected");
  });

  it("routes wallet_disconnect to the disconnect handler, not rpc or sign", async () => {
    const posted: any[] = [];
    const fakeFrame = { postMessage: (m: any) => posted.push(m) } as unknown as Window;
    const rpc = vi.fn(async () => "0xRPC");
    const confirmAndSign = vi.fn(async () => "0xSIGNED");
    const disconnect = vi.fn(() => true);
    const listener = makeBridgeListener(
      { rpc, confirmAndSign, disconnect, chainIdHex: "0x1", address: "0xA" },
      () => fakeFrame,
    );
    await listener({ data: { type: BRIDGE_REQUEST, id: 9, request: { method: "wallet_disconnect", params: [] } } } as MessageEvent);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(rpc).not.toHaveBeenCalled();
    expect(confirmAndSign).not.toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ type: BRIDGE_RESPONSE, id: 9, result: true });
  });

  it("ignores unrelated postMessages", async () => {
    const { rpc, confirmAndSign } = setup();
    const listener = makeBridgeListener(
      { rpc, confirmAndSign, chainIdHex: "0x1", address: "0xA" },
      () => null,
    );
    await listener({ data: { type: "something-else" } } as MessageEvent);
    expect(rpc).not.toHaveBeenCalled();
    expect(confirmAndSign).not.toHaveBeenCalled();
  });
});
