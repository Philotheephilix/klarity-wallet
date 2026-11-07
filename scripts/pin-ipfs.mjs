// Pin the production build (dist/) to IPFS via Pinata as a wrapped directory,
// returning a CIDv1. Run: node scripts/pin-ipfs.mjs
//
// Reads PINATA_JWT from .env (scoped key, gitignored, user-rotated). This is a
// one-time deploy step. The wrapped directory means the gateway serves
// https://<cid>.ipfs.<gw>/ -> dist/index.html, with ./assets/* resolving
// relative to it (vite base:"./" guarantees relative asset refs).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const env = Object.fromEntries(
  readFileSync(join(root, ".env"), "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const JWT = env.PINATA_JWT;
if (!JWT) throw new Error("PINATA_JWT missing from .env");

const distDir = join(root, "dist");

// Recursively collect every file under dist/.
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(distDir);
if (!files.length) throw new Error("dist/ is empty — run `npm run build` first");

// Sanity: fail loudly if any asset ref is absolute (would break on a gateway
// subpath). vite base:"./" should prevent this, but verify before pinning.
const indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
if (/(?:src|href)=["']\/(?!\/)/.test(indexHtml)) {
  throw new Error("index.html has absolute asset paths — set vite base:'./' and rebuild");
}

const form = new FormData();
for (const abs of files) {
  const rel = relative(distDir, abs).split("\\").join("/");
  const bytes = readFileSync(abs);
  // Every file shares the SAME top folder ("klarity"), so Pinata returns a CID
  // that points AT that folder. A gateway then serves
  // https://<cid>.ipfs.<gw>/ -> klarity/index.html as the directory root, with
  // ./assets/* resolving beside it. (The folder name is internal; the CID is
  // the directory, so the URL has no "/klarity" segment.)
  form.append("file", new Blob([bytes]), `klarity/${rel}`);
}
form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
form.append("pinataMetadata", JSON.stringify({ name: "klarity-wallet-dist" }));

console.log(`pinning ${files.length} files from dist/ …`);
const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
  method: "POST",
  headers: { Authorization: `Bearer ${JWT}` },
  body: form,
});
const text = await res.text();
if (!res.ok) throw new Error(`Pinata ${res.status}: ${text}`);
const json = JSON.parse(text);
const cid = json.IpfsHash;
console.log("\nPINNED OK");
console.log("CID (v1):", cid);
console.log("gateway:  https://" + cid + ".ipfs.dweb.link/");
console.log("gateway:  https://gateway.pinata.cloud/ipfs/" + cid + "/");
console.log("\nCID=" + cid);
