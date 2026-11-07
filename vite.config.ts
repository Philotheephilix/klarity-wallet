import { defineConfig } from "vite";

// Static, content-addressed build for IPFS. The wallet must load from any IPFS
// gateway or a local node under an arbitrary CID path, with NO server we run —
// so every asset reference is relative (base "./") and nothing is fetched from
// a centralized origin at build time. The ERC-8244 document, the anon-rpc
// worker, and the tor-js bundle are all inlined/bundled into dist/.
export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    // Inline small assets as data URIs so the CID bundle is self-contained.
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        // Stable, hashed names — content-addressing friendly.
        entryFileNames: "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash].[ext]",
      },
    },
  },
});
