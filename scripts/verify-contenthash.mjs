// Verify klarity.eth contenthash on Sepolia via the ENSIP-10 resolve() wrapper
// (this resolver does not expose a flat contenthash(bytes) getter).
import { createPublicClient, http, encodeFunctionData, toHex, namehash } from "viem";
import { sepolia } from "viem/chains";
import { packetToBytes } from "viem/ens";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const contentHash = require("@ensdomains/content-hash");

const RESOLVER = "0x991909eFAFD3d15BF18355F4d8Cf7aC359E4A3aD";
const NAME = "klarity.eth";
const CID = process.env.CID;
if (!CID) throw new Error("set CID=<cidv1>");

const dnsName = toHex(packetToBytes(NAME));
const node = namehash(NAME);
const abi = [
  { type: "function", name: "contenthash", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "bytes" }] },
  { type: "function", name: "resolve", stateMutability: "view", inputs: [{ name: "name", type: "bytes" }, { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] },
];
const inner = encodeFunctionData({ abi, functionName: "contenthash", args: [node] });
const expected = "0x" + contentHash.encode("ipfs", CID);
const RPCS = ["https://ethereum-sepolia.publicnode.com", "https://gateway.tenderly.co/public/sepolia", "https://0xrpc.io/sep", "https://sepolia.rpc.thirdweb.com"];

for (const url of RPCS) {
  try {
    const pc = createPublicClient({ chain: sepolia, transport: http(url, { batch: false }) });
    const r = await pc.readContract({ address: RESOLVER, abi, functionName: "resolve", args: [dnsName, inner] });
    console.log("via", url);
    console.log("expected contenthash:", expected);
    console.log("resolve() return    :", r);
    console.log("MATCH:", r.toLowerCase().includes(expected.slice(2).toLowerCase()));
    process.exit(0);
  } catch (e) {
    console.log("  fail", url, e.shortMessage || e.message);
  }
}
process.exit(1);
