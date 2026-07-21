/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NETWORK?: "TESTNET" | "PUBLIC";
  readonly VITE_RPC_URL?: string;
  readonly VITE_POSITION_SCAN_LIMIT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
