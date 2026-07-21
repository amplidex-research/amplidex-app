import { Networks } from "@stellar/stellar-sdk";

export type AppNetwork = "TESTNET" | "PUBLIC";

export type MarketDefinition = {
  symbol: string;
  name: string;
  asset: string;
  decimals: number;
};

const SUPPORTED_MARKETS: MarketDefinition[] = [
  {
    symbol: "XLM",
    name: "Stellar Lumens",
    asset: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
    decimals: 7,
  },
];

const PROTOCOL_CONTRACT_ID: string =
  "CCZ5J6NG6Q3PWUGA2PFILJ2HNIQHBKUOMB4NB7MXTZVWCC3ZXUVTIQLM";
const USDC_CONTRACT_ID: string =
  "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

const network: AppNetwork =
  import.meta.env.VITE_NETWORK === "PUBLIC" ? "PUBLIC" : "TESTNET";

export const config = {
  network,

  rpcUrl: import.meta.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org",

  passphrase: network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET,

  protocolId: PROTOCOL_CONTRACT_ID,

  usdcId: USDC_CONTRACT_ID,

  scanLimit: Number(import.meta.env.VITE_POSITION_SCAN_LIMIT || "25"),

  markets: SUPPORTED_MARKETS,
};
