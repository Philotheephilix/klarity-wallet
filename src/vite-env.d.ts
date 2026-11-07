/// <reference types="vite/client" />

declare module "*.html?raw" {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_WALLET_CONTRACT?: string;
  readonly VITE_PIMLICO_KEY?: string;
  readonly VITE_USE_TOR?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
