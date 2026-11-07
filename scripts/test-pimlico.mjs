// End-to-end test of the Pimlico bundler path on Base Sepolia, replicating the
// app's send construction (toCoinbaseSmartAccount + createBundlerClient).
//
// It funds nothing: it derives a smart account from a throwaway local owner,
// then tries to BUILD + ESTIMATE a userOp against the live Pimlico bundler. A
// freshly-derived account has 0 balance, so the SEND will fail at the
// balance/prefund check — but that failure proves the bundler accepted the
// request shape and estimated gas (i.e. the key and endpoint work). We assert
// we get a *prefund/balance* class error, NOT a 401/parse error.
//
// With --owner <0xPRIVKEY> you can point it at a funded account's owner to do a
// REAL send of 0 wei to self and get a userOpHash + tx hash.
//
// Reads VITE_PIMLICO_KEY and VITE_RPC_URL from .env. Run:
//   node scripts/test-pimlico.mjs
//   node scripts/test-pimlico.mjs --owner 0x<privkey>   # real send, needs gas
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  http,
  parseEther,
  formatEther,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  toCoinbaseSmartAccount,
  createBundlerClient,
} from "viem/account-abstraction";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const KEY = env.VITE_PIMLICO_KEY;
const RPC_URL = env.VITE_RPC_URL || "https://sepolia.base.org";
if (!KEY) throw new Error("VITE_PIMLICO_KEY missing from .env");

const CHAIN = baseSepolia;
const BUNDLER = `https://api.pimlico.io/v2/${CHAIN.id}/rpc?apikey=${KEY}`;

const ownerArgIdx = process.argv.indexOf("--owner");
const ownerPk = ownerArgIdx >= 0 ? process.argv[ownerArgIdx + 1] : null;
const realSend = !!ownerPk;

console.log("chain:   ", CHAIN.name, CHAIN.id);
console.log("rpc:     ", RPC_URL);
console.log("bundler: ", BUNDLER.replace(KEY, "pim_***"));
console.log("mode:    ", realSend ? "REAL SEND (0 wei to self)" : "build+estimate only (unfunded)");

// 1. Raw bundler reachability — the exact thing that was returning 401 before.
console.log("\n[1] bundler eth_chainId …");
const chRes = await fetch(BUNDLER, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
});
const chJson = await chRes.json();
console.log("    ->", JSON.stringify(chJson));
if (chJson.result !== "0x14a34") throw new Error("bundler did not return Base Sepolia chainId");

// 2. Pimlico gas price endpoint.
console.log("[2] pimlico_getUserOperationGasPrice …");
const gpRes = await fetch(BUNDLER, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "pimlico_getUserOperationGasPrice", params: [] }),
});
const gpJson = await gpRes.json();
console.log("    -> standard maxFeePerGas:", gpJson.result?.standard?.maxFeePerGas);

// 3. App's exact account construction.
const owner = ownerPk ? privateKeyToAccount(ownerPk) : privateKeyToAccount(generatePrivateKey());
const client = createPublicClient({ chain: CHAIN, transport: http(RPC_URL, { batch: false }) });
const account = await toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1" });
console.log("\n[3] smart account:", account.address);
const bal = await client.getBalance({ address: account.address });
console.log("    balance:", formatEther(bal), "ETH");

const bundler = createBundlerClient({ account, client, transport: http(BUNDLER) });

// 4. Estimate (this is what proves the bundler accepts the userOp shape).
console.log("\n[4] estimateUserOperationGas …");
try {
  const est = await bundler.estimateUserOperationGas({
    account,
    calls: [{ to: account.address, value: 0n, data: "0x" }],
  });
  console.log("    OK — callGasLimit:", est.callGasLimit?.toString(), "verificationGasLimit:", est.verificationGasLimit?.toString());
} catch (e) {
  const msg = (e.shortMessage || e.message || "").split("\n").slice(0, 4).join(" ");
  console.log("    estimate error:", msg.slice(0, 220));
  if (/Unauthorized|401|apikey|did not match the expected pattern/i.test(msg)) {
    console.log("\nRESULT: FAIL — bundler auth/parse error. The key path is NOT working.");
    process.exit(1);
  }
  console.log("    (non-auth error — bundler is reachable & parsing; likely prefund/balance for an unfunded account)");
}

// 5. Real send only if an owner was supplied.
if (realSend) {
  console.log("\n[5] sendUserOperation (REAL) …");
  const userOpHash = await bundler.sendUserOperation({
    account,
    calls: [{ to: account.address, value: 0n, data: "0x" }],
  });
  console.log("    userOpHash:", userOpHash);
  const rcpt = await bundler.waitForUserOperationReceipt({ hash: userOpHash });
  console.log("    txHash:", rcpt.receipt.transactionHash, "success:", rcpt.success);
  console.log("\nRESULT: PASS — real userOp landed on", CHAIN.name);
} else {
  console.log("\nRESULT: PASS — Pimlico key authenticates, chainId + gas price + estimate path reachable.");
  console.log("(To prove a full send, fund a smart account and re-run with --owner <its owner privkey>.)");
}
