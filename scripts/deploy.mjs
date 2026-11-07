// Deploy HtmlHost to Base Sepolia, upload walletDocument.html in chunks, then
// verify html() round-trips the exact bytes. Run: node scripts/deploy.mjs
//
// Reads DEPLOYER_PRIVATE_KEY from .env (testnet only). Deployment talks to the
// RPC directly — it is a one-time build step, not the wallet's runtime path
// (the wallet's reads + userOps still ride the anon transport at runtime).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createWalletClient, createPublicClient, http, getContract,
  decodeAbiParameters, parseAbiParameters, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// minimal .env reader (no dep)
const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const pk = env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY missing from .env");
const RPC = env.VITE_RPC_URL || "https://sepolia.base.org";

const artifact = JSON.parse(readFileSync(join(root, "contracts/HtmlHost.json"), "utf8"));
const html = readFileSync(join(root, "src/walletDocument.html"), "utf8");

const account = privateKeyToAccount(pk);
const transport = http(RPC);
const wallet = createWalletClient({ account, chain: baseSepolia, transport });
const pub = createPublicClient({ chain: baseSepolia, transport });

console.log("deployer:", account.address);
const bal = await pub.getBalance({ address: account.address });
console.log("balance :", Number(bal) / 1e18, "ETH on Base Sepolia");
if (bal === 0n) {
  console.error("\nERROR: deployer has 0 ETH on Base Sepolia. Fund it at a faucet:");
  console.error("  https://www.alchemy.com/faucets/base-sepolia  (address above)");
  process.exit(1);
}

// 1) deploy the host
console.log("\ndeploying HtmlHost…");
const deployHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [] });
const rcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
const addr = rcpt.contractAddress;
console.log("HtmlHost:", addr, "(tx", deployHash + ")");

const host = getContract({ address: addr, abi: artifact.abi, client: wallet });

// 2) upload HTML in chunks (<=20KB each, under the 24KB SSTORE2 cap)
const bytes = Buffer.from(html, "utf8");
const CHUNK = 20000;
const nChunks = Math.ceil(bytes.length / CHUNK);
console.log(`\nuploading ${bytes.length} bytes in ${nChunks} chunk(s)…`);
for (let i = 0; i < nChunks; i++) {
  const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
  const h = await host.write.addChunk([toHex(slice)]);
  await pub.waitForTransactionReceipt({ hash: h });
  console.log(`  chunk ${i + 1}/${nChunks}: ${slice.length} bytes (tx ${h})`);
}

// 3) verify html() round-trips EXACTLY
console.log("\nverifying html()…");
const raw = await pub.call({ to: addr, data: "0x33c34ac3" });
const [served] = decodeAbiParameters(parseAbiParameters("string"), raw.data);
const ok = served === html;
console.log("round-trip exact match:", ok ? "YES ✓" : "NO ✗");
if (!ok) {
  console.error(`served ${served.length} chars, original ${html.length} chars`);
  process.exit(1);
}

console.log("\n=== DONE ===");
console.log("Set this in .env to serve the UI from the contract:");
console.log("VITE_WALLET_CONTRACT=" + addr);
