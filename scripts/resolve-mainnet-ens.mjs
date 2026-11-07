// Resolve klarityy.eth via the mainnet Universal Resolver, which (unlike the
// classic registry) follows ENSIP-10 wildcard / ENS v2 / offchain resolution.
// Read-only. Confirms whether the name resolves and what resolver backs it.
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const NAME = process.env.NAME || "klarityy.eth";

const RPCS = [
  process.env.MAINNET_RPC,
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
console.log("name:", NAME, "\nrpc: ", used);

// viem uses the chain's configured Universal Resolver under the hood.
try {
  const resolver = await pc.getEnsResolver({ name: NAME });
  console.log("ENS resolver (via Universal Resolver):", resolver);
} catch (e) {
  console.log("getEnsResolver failed:", e.shortMessage || e.message);
}
try {
  const addr = await pc.getEnsAddress({ name: NAME });
  console.log("addr record:", addr);
} catch (e) {
  console.log("getEnsAddress failed:", e.shortMessage || e.message);
}
