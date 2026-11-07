// Compile contracts/HtmlHost.sol with solc (pure JS) and write the artifact to
// contracts/HtmlHost.json. Run: node scripts/compile.mjs
import solc from "solc";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "contracts/HtmlHost.sol"), "utf8");

const input = {
  language: "Solidity",
  sources: { "HtmlHost.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors ?? []).filter((e) => e.severity === "error");
if (errs.length) {
  console.error(errs.map((e) => e.formattedMessage).join("\n"));
  process.exit(1);
}
for (const w of out.errors ?? []) console.warn(w.formattedMessage);

const c = out.contracts["HtmlHost.sol"].HtmlHost;
const artifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
writeFileSync(join(root, "contracts/HtmlHost.json"), JSON.stringify(artifact, null, 2));
console.log("compiled -> contracts/HtmlHost.json  (bytecode", artifact.bytecode.length / 2 - 1, "bytes)");
