import { describe, it, expect } from "vitest";
import { createPublicClient, http, encodeAbiParameters, parseAbiParameters, decodeAbiParameters } from "viem";
import { baseSepolia } from "viem/chains";
import { toCoinbaseSmartAccount, toWebAuthnAccount } from "viem/account-abstraction";
import { injectProvider } from "../src/lib/hostRenderer";
import { SIGNING_METHODS } from "../src/lib/providerBridge";

// A fixed P-256 public key (x,y) so the derived account address is deterministic.
// This is a known test vector — any valid P-256 point works for address derivation.
const TEST_CREDENTIAL = {
  id: "test-credential-id",
  publicKey:
    "0x1c05286fe694493eae33312f2d2e0d0abeda8db76238b7a204be1fb87f54ce4228fef61ef4ac300f631657635c28e59bfb2fe71bdf8c90a6ec5e481d8e653786" as `0x${string}`,
};

describe("counterfactual smart-account derivation", () => {
  it("derives a stable address from a passkey public key with no deploy", async () => {
    const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
    const owner = toWebAuthnAccount({ credential: TEST_CREDENTIAL as any });
    const account = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });

    // address is available immediately (counterfactual), is a valid 20-byte addr
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // deriving again from the same key yields the SAME address (determinism)
    const account2 = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });
    expect(account2.address).toBe(account.address);
  });

  it("different passkey keys give different accounts", async () => {
    const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
    const a = await toCoinbaseSmartAccount({
      client,
      owners: [toWebAuthnAccount({ credential: TEST_CREDENTIAL as any })],
      version: "1.1",
    });
    const other = {
      id: "other",
      publicKey: ("0x" + "11".repeat(32) + "22".repeat(32)) as `0x${string}`,
    };
    const b = await toCoinbaseSmartAccount({
      client,
      owners: [toWebAuthnAccount({ credential: other as any })],
      version: "1.1",
    });
    expect(a.address).not.toBe(b.address);
  });
});

describe("ERC-8244 html() round-trip", () => {
  it("abi-encodes and decodes a document losslessly", () => {
    const doc = `<!doctype html><html><head></head><body>wallet</body></html>`;
    const encoded = encodeAbiParameters(parseAbiParameters("string"), [doc]);
    const [decoded] = decodeAbiParameters(parseAbiParameters("string"), encoded);
    expect(decoded).toBe(doc);
  });

  it("injects the provider script into <head>", () => {
    const doc = `<!doctype html><html><head><title>x</title></head><body></body></html>`;
    const out = injectProvider(doc, "0x14a34", "0xabc");
    expect(out).toContain("<script>");
    expect(out).toContain("window.ethereum");
    expect(out).toContain("0x14a34"); // chainId embedded
    // script must be inside head, before the title
    expect(out.indexOf("window.ethereum")).toBeLessThan(out.indexOf("<title>"));
  });

  it("injects before body when no head present", () => {
    const doc = `<html><body>hi</body></html>`;
    const out = injectProvider(doc, "0x1", "0x0");
    expect(out).toContain("window.ethereum");
    expect(out.indexOf("window.ethereum")).toBeLessThan(out.indexOf("<body>"));
  });
});

describe("provider bridge signing gate", () => {
  it("classifies signing methods as gated", () => {
    expect(SIGNING_METHODS.has("eth_sendTransaction")).toBe(true);
    expect(SIGNING_METHODS.has("personal_sign")).toBe(true);
    expect(SIGNING_METHODS.has("eth_signTypedData_v4")).toBe(true);
  });
  it("does not gate read methods", () => {
    expect(SIGNING_METHODS.has("eth_getBalance")).toBe(false);
    expect(SIGNING_METHODS.has("eth_call")).toBe(false);
    expect(SIGNING_METHODS.has("eth_chainId")).toBe(false);
  });
});
