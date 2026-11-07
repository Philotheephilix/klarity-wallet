// Inspect klarityy.eth on ENS MAINNET: resolver, owner, manager, current
// contenthash. Read-only. Prints what we'd need to set contenthash.
import { createPublicClient, http, namehash, toHex } from "viem";
import { mainnet } from "viem/chains";
import { packetToBytes } from "viem/ens";

const NAME = process.env.NAME || "klarityy.eth";
const node = namehash(NAME);
const dnsName = toHex(packetToBytes(NAME));

// ENS registry (same address on mainnet for v1; v2 names may use a name wrapper
// or a different registry — we read the classic registry first to learn the
// resolver, then query the resolver directly).
const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const NAME_WRAPPER = "0xD4416b13d2b3a9aBae7AcD5b6C8d6da3c3b7a4e4"; // mainnet wrapper (for owner-of check)

const regAbi = [
  { type: "function", name: "resolver", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] },
];
const resAbi = [
  { type: "function", name: "contenthash", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "bytes" }] },
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "resolve", stateMutability: "view", inputs: [{ name: "name", type: "bytes" }, { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] },
];

const RPCS = [
  process.env.MAINNET_RPC,
  "https://eth.llamarpc.com",
  "https://ethereum-rpc.publicnode.com",
  "https://1rpc.io/eth",
  "https://rpc.ankr.com/eth",
  "https://cloudflare-eth.com",
].filter(Boolean);

let pc, used;
for (const url of RPCS) {
  try {
    const c = createPublicClient({ chain: mainnet, transport: http(url, { batch: false }) });
    await c.getBlockNumber();
    pc = c; used = url; break;
  } catch (e) { console.log("  rpc skip", url, e.shortMessage || e.message); }
}
if (!pc) throw new Error("no mainnet RPC reachable");

console.log("name:   ", NAME);
console.log("node:   ", node);
console.log("rpc:    ", used);

let resolver;
try {
  resolver = await pc.readContract({ address: REGISTRY, abi: regAbi, functionName: "resolver", args: [node] });
  console.log("resolver:", resolver);
} catch (e) { console.log("resolver read failed:", e.shortMessage || e.message); }

try {
  const owner = await pc.readContract({ address: REGISTRY, abi: regAbi, functionName: "owner", args: [node] });
  console.log("registry owner:", owner);
} catch (e) { console.log("owner read failed:", e.shortMessage || e.message); }

if (resolver && resolver !== "0x0000000000000000000000000000000000000000") {
  try {
    const ch = await pc.readContract({ address: resolver, abi: resAbi, functionName: "contenthash", args: [node] });
    console.log("current contenthash:", ch);
  } catch (e) { console.log("contenthash(bytes32) read failed:", e.shortMessage || e.message); }
  try {
    const a = await pc.readContract({ address: resolver, abi: resAbi, functionName: "addr", args: [node] });
    console.log("addr():", a);
  } catch (e) { console.log("addr read failed:", e.shortMessage || e.message); }
} else {
  console.log("\nNo resolver set on this name yet — resolver must be set before contenthash.");
}
