import {
  Address,
  Contract,
  Networks,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
  Account,
} from "@stellar/stellar-sdk";

import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit-tech/stellar-wallets-kit/modules/utils";
import { config } from "./config";

let initialized = false;
export function initWalletKit() {
  if (initialized) return;
  StellarWalletsKit.init({
    modules: defaultModules(),
    network: config.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET,
  });
  initialized = true;
}

export async function connectWallet(): Promise<string> {
  initWalletKit();
  const { address } = await StellarWalletsKit.authModal();
  return address;
}

export async function restoreWallet(): Promise<string | null> {
  try {
    initWalletKit();
    return (await StellarWalletsKit.getAddress()).address;
  } catch {
    return null;
  }
}

const server = new rpc.Server(config.rpcUrl);

export const sc = {
  address: (v: string) => new Address(v).toScVal(),
  i128: (v: bigint) => nativeToScVal(v, { type: "i128" }),
  u32: (v: number) => nativeToScVal(v, { type: "u32" }),
  u64: (v: bigint | number) => nativeToScVal(BigInt(v), { type: "u64" }),
  bool: (v: boolean) => nativeToScVal(v, { type: "bool" }),
  optionU32: (v: number | null) =>
    v === null ? xdr.ScVal.scvVoid() : nativeToScVal(v, { type: "u32" }),
  side: (v: "Long" | "Short") => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(v)]),
};

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function readContract(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  source?: string
) {
  if (!contractId) throw new Error("Missing contract ID in .env");
  const sourceKey =
    source || "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const account = source
    ? await server.getAccount(sourceKey)
    : new Account(sourceKey, "0");
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: config.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  if (!sim.result) return null;
  return scValToNative(sim.result.retval);
}

export async function invokeContract(
  address: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[] = []
) {
  if (!address) throw new Error("Connect a wallet first");
  const account = await server.getAccount(address);
  const tx = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: config.passphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(180)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) throw new Error(simulation.error);
  const prepared = rpc.assembleTransaction(tx, simulation).build();
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(
    prepared.toXDR(),
    {
      networkPassphrase: config.passphrase,
      address,
    }
  );
  const signed = TransactionBuilder.fromXDR(
    signedTxXdr,
    config.passphrase
  ) as Transaction;
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR")
    throw new Error(
      `Submission failed: ${sent.errorResult?.toXDR("base64") || sent.status}`
    );
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash: sent.hash,
        result: result.returnValue ? scValToNative(result.returnValue) : null,
      };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED)
      throw new Error(`Transaction failed: ${sent.hash}`);
  }
  throw new Error(
    `Transaction submitted but timed out while waiting: ${sent.hash}`
  );
}

export async function safeRead<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    console.warn(errorText(e));
    return null;
  }
}
