// Set klarity.eth contenthash on Sepolia (ENS v2 permissioned resolver) to the
// pinned IPFS CID. SIMULATE-ONLY unless run with `--send`.
//   node scripts/set-contenthash.mjs            # simulate
//   node scripts/set-contenthash.mjs --send     # simulate then broadcast
//
// Reads DEPLOYER_PRIVATE_KEY from .env (testnet only). The deployer owns
// klarity.eth, so it should hold the role to set contenthash on the resolver.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWalletClient, createPublicClient, http, toHex, encodeFunctionData } from "viem";
import { sepolia } from "viem/chains";
import { packetToBytes } from "viem/ens";
import { privateKeyToAccount } from "viem/accounts";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const contentHash = require("@ensdomains/content-hash");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const pk = env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY missing from .env");

const CID = process.env.CID || "bafybeiaeis2hjbnarvvj6uu5fqtmabm6yfq7445huntuuwjmpilczzntru";
const RESOLVER = "0x991909eFAFD3d15BF18355F4d8Cf7aC359E4A3aD";
const NAME = "klarity.eth";
const SEND = process.argv.includes("--send");

const account = privateKeyToAccount(pk);
console.log("deployer:", account.address);

// Try several public Sepolia RPCs until one answers.
const RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://1rpc.io/sepolia",
  "https://rpc.sepolia.org",
];
let RPC;
for (const url of RPCS) {
  try {
    const c = createPublicClient({ chain: sepolia, transport: http(url, { batch: false }) });
    await c.getBlockNumber();
    RPC = url; break;
  } catch { /* next */ }
}
if (!RPC) throw new Error("no Sepolia RPC reachable");
console.log("RPC:", RPC);

const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC, { batch: false }) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC, { batch: false }) });

const dnsName = toHex(packetToBytes(NAME));
const encoded = "0x" + contentHash.encode("ipfs", CID);
console.log("DNS name:    ", dnsName);
console.log("contenthash: ", encoded);

const abi = [
  { type: "function", name: "setContenthash", stateMutability: "nonpayable",
    inputs: [{ name: "name", type: "bytes" }, { name: "hash", type: "bytes" }], outputs: [] },
  { type: "function", name: "contenthash", stateMutability: "view",
    inputs: [{ name: "name", type: "bytes" }], outputs: [{ type: "bytes" }] },
];

// Simulate first — this surfaces a missing-role revert before we spend gas.
console.log("\nsimulating setContenthash …");
try {
  await publicClient.simulateContract({
    account, address: RESOLVER, abi, functionName: "setContenthash", args: [dnsName, encoded],
  });
  console.log("SIMULATION OK — the call would succeed.");
} catch (e) {
  console.error("SIMULATION REVERTED:", e.shortMessage || e.message);
  if (!SEND) process.exit(1);
  console.error("proceeding to send anyway because --send was passed");
}

if (!SEND) {
  console.log("\n(dry run — pass --send to broadcast)");
  process.exit(0);
}

console.log("\nsending …");
// Public Sepolia RPCs rate-limit the write leg ("Request exceeds defined
// limit") even when the health probe passed. Rotate across all RPCs with
// backoff so one throttled endpoint doesn't abort the broadcast.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hash, sendRpc;
for (let attempt = 0; attempt < RPCS.length * 2 && !hash; attempt++) {
  const url = RPCS[attempt % RPCS.length];
  try {
    const wc = createWalletClient({ account, chain: sepolia, transport: http(url, { batch: false }) });
    hash = await wc.writeContract({
      address: RESOLVER, abi, functionName: "setContenthash", args: [dnsName, encoded],
    });
    sendRpc = url;
  } catch (e) {
    console.error(`  send via ${url} failed:`, e.shortMessage || e.message);
    await sleep(1500 * (attempt + 1));
  }
}
if (!hash) throw new Error("all RPCs rejected the broadcast (rate-limited)");
console.log("tx:", hash, "via", sendRpc);

let rcpt;
for (let attempt = 0; attempt < RPCS.length * 3 && !rcpt; attempt++) {
  const url = RPCS[attempt % RPCS.length];
  try {
    const pc = createPublicClient({ chain: sepolia, transport: http(url, { batch: false }) });
    rcpt = await pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (e) {
    console.error(`  receipt via ${url} not ready:`, e.shortMessage || e.message);
    await sleep(3000 * (attempt + 1));
  }
}
if (!rcpt) throw new Error(`tx ${hash} sent but no receipt yet — check a Sepolia explorer`);
console.log("status:", rcpt.status, "block:", rcpt.blockNumber);

// Read it back (via ENSIP-10 resolve() if the flat getter is unsupported).
for (const url of RPCS) {
  try {
    const pc = createPublicClient({ chain: sepolia, transport: http(url, { batch: false }) });
    const stored = await pc.readContract({
      address: RESOLVER, abi, functionName: "contenthash", args: [dnsName],
    });
    console.log("stored contenthash:", stored);
    console.log("matches:", stored.toLowerCase() === encoded.toLowerCase());
    break;
  } catch (e) {
    console.log(`read-back via ${url} failed:`, e.shortMessage || e.message);
  }
}
