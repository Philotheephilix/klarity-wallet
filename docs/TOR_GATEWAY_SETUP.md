# anon-rpc tor-js Gateway — Setup & Public Exposure

This guide is for the **operator** of the machine that will run the anon-rpc
tor-js KPS gateway. The wallet (the browser app in this repo) is only a
*client* — it cannot make Tor work on its own. Real Tor requires a **live
gateway peer** that the browser can dial.

The gateway baked into the wallet is now a **live, operator-run** one:
`161.118.166.4:12298:uEiC7vWc1fxm8QL4ScIBWbGWMLdYb5RdCqn8h8CGLH0nevQ`. The
browser dials it over WebRTC, pulls the Tor directory snapshot, bootstraps a
consensus (~18–21s), and tunnels real RPC through Tor. **Real Tor works.**

This guide remains the operator reference for standing up or replacing that
gateway (e.g. moving it behind `mcp.philotheephilix.in/tor`). If the gateway
moves or its cert rotates, follow the steps here and swap the string in
`src/lib/anonTransport.ts`.

---

## What the gateway is (and why it's needed)

- The wallet runs the hash-pinned **tor-js** anon-client inside a sandboxed
  Web Worker. That client speaks the Tor protocol but, in a browser, it has
  **no raw sockets** — it can only reach the network over **WebRTC**.
- A **KPS gateway** is the bridge: it accepts a browser's WebRTC connection
  (peer identity pinned by a certificate hash, not DNS/CA), and relays that
  traffic out to the real Tor network. It also serves `bootstrap.zip.zst`
  (a packaged Tor directory snapshot) so the client can fast-bootstrap a
  consensus.
- The browser identifies the gateway by a single string:

  ```
  <ip>:<port>:<certhash>
  ```

  e.g. `152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ`

  - `ip:port` — where the gateway listens.
  - `certhash` — multibase (`uEi…`) hash of the gateway's KPS certificate.
    This is the **trust anchor**: the browser will only talk to a peer that
    presents a cert matching this hash. It is produced by the gateway at
    startup (see below); you cannot pick it arbitrarily.

---

## What to run on the host

> Run this on the box behind `mcp.philotheephilix.in`. These are the
> operator's steps — they happen on the server, not in this repo.

### 1. Get the gateway binary

The gateway ships with the anon-rpc project (`ethereum/anon-rpc`), under the
tor-js / gateway package. Build or install it on the host:

```sh
# on the gateway host
git clone https://github.com/ethereum/anon-rpc
cd anon-rpc
# follow the repo's build instructions for the tor-js gateway
# (Rust + wasm toolchain; the gateway side is the native relay, not the wasm client)
```

> If the repo names the gateway component differently, use whatever it calls
> the **KPS gateway / relay** that terminates browser WebRTC and bridges to
> Tor. That is the piece we need — not the browser harness (which is the
> client we already have).

### 2. Start the gateway and capture its cert hash

On first start the gateway generates (or loads) a KPS certificate and prints
its **cert hash** — the `uEi…` value. Capture it; it goes into the wallet
config.

```sh
# example shape — adjust flags to the actual binary:
anon-rpc-gateway \
  --listen 0.0.0.0:12298 \
  --tor-bridge \
  --emit-cert-hash
# -> prints something like:
#    gateway cert hash: uEiCxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
#    listening on 0.0.0.0:12298
```

Keep the certificate/key persistent across restarts so the hash is **stable**
— if it changes, every client's pinned `certhash` breaks and you must update
the wallet config again.

---

## What to expose publicly (the ask to the host operator)

Expose the gateway at the public endpoint **`mcp.philotheephilix.in/tor`**.

Because the browser dials over **WebRTC**, exposure is not a plain HTTP reverse
proxy of one port. Make sure the following are reachable from the public
internet:

1. **The gateway's signaling/handshake endpoint** reachable at
   `https://mcp.philotheephilix.in/tor`
   - Terminate TLS at the edge (the public cert for `mcp.philotheephilix.in`).
   - Proxy `/tor` (and any sub-path the gateway uses for WebRTC signaling /
     SDP offer-answer) through to the gateway process.
   - WebRTC signaling is usually HTTP(S) or WebSocket — allow **WebSocket
     upgrade** on this path.

2. **The WebRTC media/data path (ICE).** After signaling, the actual data
   channel is UDP/TCP negotiated via ICE. Either:
   - give the host a **public IP with the UDP ephemeral range open**, or
   - run a **TURN server** and advertise it, so browsers behind NAT can still
     reach the gateway. Without a reachable ICE path, signaling succeeds but
     the data channel never opens (looks like a hang / `peer connection
     failed`).

3. **Stable identity.** The `certhash` must not change on restart — persist
   the cert/key on disk.

### Concrete request to whoever runs `mcp.philotheephilix.in`

> Please run the anon-rpc tor-js KPS gateway and expose it at
> `https://mcp.philotheephilix.in/tor`:
> - TLS-terminate `mcp.philotheephilix.in` and reverse-proxy the `/tor` path
>   (with WebSocket upgrade) to the gateway's signaling endpoint.
> - Open the WebRTC ICE path to the public internet (public IP + open UDP
>   ephemeral ports, or a reachable TURN server).
> - Keep the gateway's KPS certificate persistent so its cert hash is stable,
>   and send me back the final gateway string in the form
>   `<public-host-or-ip>:<port>:<certhash>`.

Example nginx sketch for the signaling path (adjust to the gateway's real
routes/port):

```nginx
location /tor/ {
    proxy_pass http://127.0.0.1:12298/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 300s;
}
```

---

## Wiring the gateway into the wallet

Once the operator returns a **live** gateway string, put it in
`src/lib/anonTransport.ts` under `SPECIFIERS.torJs.config.gateways`:

```ts
torJs: {
  label: "tor-js (real Tor)",
  address: "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e",
  config: {
    gateways: [
      // replace the dead demo gateway with ours:
      "mcp.philotheephilix.in:<port>:<certhash>",
    ],
  },
  anonymous: true,
},
```

Notes:
- The gateway string uses **host:port:certhash**. If the gateway is reached
  purely through the `/tor` HTTPS path (no separate port), confirm with the
  operator what the tor-js client expects here — some builds take a URL-style
  entry, others strictly `ip:port:certhash`. Match whatever the running
  gateway advertises.
- Keep `VITE_USE_TOR=1` in `.env` to request Tor at boot.

### Verify it actually bootstrapped

```sh
npm run dev
# open the app, watch the browser console (worker logs)
```

You want to see the log progress **past** the demo failure:

- BAD (current):
  `Fast bootstrap failed … all gateways failed … peer connection failed`
  then `[boot] Tor transport failed, falling back to passthrough`.
- GOOD (gateway live):
  `Fast bootstrap: fetching bootstrap.zip.zst…` → succeeds, then
  `Bootstrapping Tor client…` → `Looking for a consensus` → **bootstrapped**,
  and the origin banner reads **anon: Tor**.

The wallet has a 25s Tor deadline (`bringUpAnon` in `src/main.ts`): if the
gateway is reachable but slow, raise that deadline; if it's unreachable it
falls back to passthrough so the app still loads.

---

## Quick reachability check (from anywhere)

Before touching the wallet, confirm the gateway port is actually listening —
this is the test that currently fails for the demo gateway:

```sh
# plain TCP reachability (friendliest possible check)
nc -z -w 8 <host> <port> && echo "OPEN" || echo "CLOSED"
```

The demo `152.236.3.22:12298` returns CLOSED (host pings, port dead). Ours must
return OPEN, and additionally pass a real WebRTC handshake from a browser.

---

## Summary

| Piece | Where | Status |
|-------|-------|--------|
| Contract-served HTML | `html()` on `0x6197…6792` (Base Sepolia) | ✅ done, verified 28,088 bytes |
| anon transport wiring | `src/lib/anonTransport.ts` | ✅ reads + bundler tunnel through it |
| Graceful Tor fallback | `bringUpAnon` in `src/main.ts` | ✅ 25s deadline → passthrough |
| **Live Tor gateway** | `mcp.philotheephilix.in/tor` | ⛔ **operator must stand this up** |

Real Tor is blocked on exactly one thing: a **live gateway peer**. This doc is
the instruction set to create one and the exact string to hand back so the
wallet can use it.
