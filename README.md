# Klarity Wallet

An **indestructible**, censorship-resistant Ethereum smart-account wallet. The
goal is a wallet with no server we run and no single point that can be taken
down: its UI is delivered from content-addressed / on-chain storage, its
JSON-RPC traffic rides an anonymizing network, and it is reachable by a
human-readable name that resolves through ENS. Every hop is designed so that
removing any one piece of centralized infrastructure does not kill the wallet.

The account itself is an ERC-4337 smart account controlled by a WebAuthn/passkey
(PRF-derived) key, so there is no seed phrase to leak. This README focuses on the
five delivery/transport subsystems the wallet is built around.

---

## 1. The "unknown" RPC and how it is used (anon transport)

There is no fixed, trusted RPC endpoint. A **destination RPC URL** (e.g.
`https://sepolia.base.org`, set by `VITE_RPC_URL`) is treated as an *untrusted,
swappable* destination — it never sees who is asking, because every request to it
is tunneled through the **anon transport**.

- `src/lib/anonTransport.ts` wraps `@anon-rpc/browser-harness`'s `AnonRpcWorker`.
  The worker runs an anonymizing client inside its **own null-origin sandboxed
  iframe + Web Worker**; the host constructs it and does nothing else.
- `worker.fetch` is a WHATWG `fetch` that tunnels a request to **any** destination
  URL. A **specifier** (an on-chain profile in `SPECIFIERS`) picks *which network*
  carries it — not the target:
  - `passthrough` — dev default, **not anonymous** (lets everything run without Tor);
  - `torJs` — real Tor, through an operator-run gateway (see below);
  - `nym` — Nym mixnet.
- `anonViemTransport()` exposes this as a viem `custom` transport, so **both**
  chain reads (`eth_call`, etc.) **and** the ERC-4337 bundler `POST` ride the anon
  network. No JSON-RPC ever leaves over clearnet at runtime.
- **Bootstrap problem:** the anon client must read its specifier contract once at
  startup. To avoid depending on a live clearnet RPC for that one hop, the
  specifier read is answered from a **local passthrough provider** by default; a
  bundled/local answerer replaces it in production so the only non-anonymous
  bootstrap hop is eliminated.

Note: the **deploy-time** scripts (`scripts/*.mjs`) talk to public RPCs directly
(with multi-RPC rotation + backoff) — those are one-time build steps, not the
wallet's runtime path.

## 2. The gateway

In Tor mode (`torJs` specifier), traffic exits through an **operator-run gateway**
rather than a public exit, so the wallet reaches clearnet RPCs/bundlers without
running a local Tor daemon in the browser. The gateway is configured in the
specifier's `config.gateways` (host:port:key) and defaults to the operator's node
(`mcp.philotheephilix.in`); it can be overridden if the node moves. Set
`VITE_USE_TOR=1` to route through the real Tor specifier instead of the dev
passthrough. Because the gateway can go down, runtime anon operations are bounded
with `withTimeout()` so a dead gateway surfaces an error instead of hanging.

## 3. ENS — resolving the ETH name (klarity.eth)

The wallet is published under an ENS name so users reach it by name, not by a
raw CID or IP.

- **Mainnet resolution (read):** `scripts/resolve-mainnet-ens.mjs` resolves
  `klarity(y).eth` through the **Universal Resolver**, which (unlike the classic
  registry) follows **ENSIP-10** wildcard / ENS v2 / offchain resolution. It
  reports the backing resolver and the address record.
- **Setting the contenthash (write):** `scripts/set-contenthash.mjs` writes the
  pinned IPFS CID into the name's `contenthash` record on an ENS v2 permissioned
  resolver (Sepolia). It encodes the CID with `@ensdomains/content-hash` (`ipfs`
  codec) and the name with `packetToBytes`, **simulates first** to surface a
  missing-role revert before spending gas, and only broadcasts with `--send`
  (rotating across RPCs because public endpoints rate-limit the write leg).
- Result: an ENS-aware browser/gateway that reads `klarity.eth`'s contenthash is
  pointed at the IPFS directory holding the wallet — the name is the stable entry
  point, the CID behind it can be re-pinned/updated.

`scripts/inspect-mainnet-ens.mjs` is a deeper read-only diagnostic for the name's
resolver/records.

## 4. IPFS — content-addressed UI delivery

The production build is a **static, content-addressed bundle** so it can load from
any IPFS gateway or a local node with no origin server.

- `vite.config.ts` builds with `base: "./"` (every asset reference relative),
  inlines small assets as data URIs, and bundles the ERC-8244 document, the
  anon-rpc worker, and the Tor bundle into `dist/` — the CID bundle is
  self-contained.
- `scripts/pin-ipfs.mjs` pins `dist/` to IPFS **via Pinata** as a wrapped
  directory (`cidVersion: 1`), returning a **CIDv1**. Every file is appended under
  one shared top folder, so the CID points at that directory and a gateway serves
  `https://<cid>.ipfs.<gw>/ -> index.html` with `./assets/*` resolving beside it.
  It fails loudly if `index.html` contains any absolute asset path (which would
  break on a gateway subpath).
- That CID is what gets written into the ENS `contenthash` (step 3), closing the
  loop: **name -> CID -> self-contained UI.**

`scripts/verify-contenthash.mjs` checks that the on-chain contenthash matches the
pinned CID.

## 5. ERC-8244 — HTML content delivery from a contract

As an alternative (or complement) to IPFS, the wallet UI document can be served
**directly from an Ethereum contract** per **ERC-8244** (contract-hosted
application), so the UI lives on-chain with no hosting at all.

- `contracts/HtmlHost.sol` serves the document via **`html()`** (selector
  `0x33c34ac3 = bytes4(keccak256("html()"))`), a `pure`/`view` call that costs the
  caller no gas. The document is larger than the EIP-170 24KB contract-code cap,
  so its bytes are stored as the **runtime code of one or more SSTORE2 data
  contracts** (each prefixed with a `STOP` guard byte so the data can never
  execute) and stitched back together with `extcodecopy` at read time.
- `scripts/deploy.mjs` deploys `HtmlHost` to Base Sepolia, uploads
  `src/walletDocument.html` in ≤20KB chunks via `addChunk`, then verifies
  `html()` **round-trips the exact bytes**. It prints `VITE_WALLET_CONTRACT=<addr>`
  to point the wallet at the on-chain UI.
- **Runtime render (`src/lib/hostRenderer.ts`):** the host fetches `html()`
  **through the anon transport** (so even loading the UI is anonymized), injects
  the EIP-1193 provider-bridge script, and mounts the document in a
  **sandboxed iframe** (`sandbox="allow-scripts"` only — null-origin, no
  `allow-same-origin`, no top-navigation). Per ERC-8244 the document is
  **untrusted**: the origin address and chain id are rendered by the **host,
  outside the frame** (`renderOrigin()` in `src/main.ts`), where the document
  cannot forge or overlay them, and every signing request is gated by a
  host-side confirmation (`confirmAndSign()`).

---

## How the pieces fit together

```
  klarity.eth  ──ENS (Universal Resolver, contenthash)──▶  IPFS CIDv1 (dist/)
                                                              │
                                                              ▼
                                                    self-contained UI loads
                                                              │
   or  VITE_WALLET_CONTRACT ──ERC-8244 html() (via anon transport)──▶ UI document
                                                              │
                                                              ▼
                       sandboxed iframe + host-rendered origin + signing gate
                                                              │
      all eth_call / bundler POST  ──anon transport (passthrough | Tor gateway | Nym)──▶  RPC
```

- **Account:** ERC-4337 smart account, passkey/PRF-controlled (`src/lib/account.ts`).
- **No seed phrase, no server we run, name-addressed, content-addressed, anonymized.**

## Development

```bash
npm install
cp .env.example .env     # fill in testnet values (never commit .env)
npm run dev              # vite dev server (passthrough transport by default)
npm run build            # type-check + static content-addressed build
npm test                 # vitest
```

### Deploy / publish (one-time, testnet)

```bash
node scripts/deploy.mjs              # deploy HtmlHost + upload UI (ERC-8244)
node scripts/pin-ipfs.mjs            # pin dist/ to IPFS -> CIDv1
node scripts/set-contenthash.mjs --send   # point klarity.eth at the CID
node scripts/verify-contenthash.mjs  # confirm on-chain contenthash == CID
```

> **Secrets:** `DEPLOYER_PRIVATE_KEY` (testnet), `PINATA_JWT`, and
> `VITE_PIMLICO_KEY` live only in `.env`, which is gitignored. `.env.example`
> documents the shape with placeholders. Never commit real keys.
