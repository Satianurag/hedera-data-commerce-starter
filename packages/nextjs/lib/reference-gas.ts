import type { WalletProvider } from "../app/wallet/injected";
import type { ReferenceWalletAction } from "./reference-types";

const maximumGas = 400_000n;
const maximumFeeWei = 500_000_000_000_000_000n; // 0.5 HBAR in JSON-RPC's 18-decimal units.

function quantity(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) {
    throw new Error(`Wallet returned an invalid ${name}`);
  }
  return BigInt(value);
}

export function referenceGasLimits(estimateRaw: unknown, gasPriceRaw: unknown, balanceRaw: unknown): {
  gas: string; gasPrice: string; maximumFeeWei: string;
} {
  const estimate = quantity(estimateRaw, "gas estimate");
  const gasPrice = quantity(gasPriceRaw, "gas price");
  const balance = quantity(balanceRaw, "HBAR balance");
  if (estimate <= 0n || gasPrice <= 0n) throw new Error("Gas estimate and gas price must be positive");
  // Hedera recommends buffering dynamic estimates. An observed refund failed at
  // the exact 64,563 estimate and succeeded at 100,000 gas; keep the fee bounded.
  // https://hedera.com/blog/estimate-gas-dynamically/
  const gas = (estimate * 3n + 1n) / 2n + 10_000n;
  if (gas > maximumGas) throw new Error("Buffered gas estimate exceeds the 400,000 gas limit; no wallet transaction was requested");
  const fee = gas * gasPrice;
  if (fee > maximumFeeWei) throw new Error("Maximum network fee exceeds the 0.5 HBAR limit; no wallet transaction was requested");
  if (balance < fee) throw new Error("Wallet HBAR balance is below the maximum network fee; no wallet transaction was requested");
  return { gas: `0x${gas.toString(16)}`, gasPrice: `0x${gasPrice.toString(16)}`, maximumFeeWei: fee.toString() };
}

export async function prepareReferenceGas(provider: Pick<WalletProvider, "request">, from: string,
    transaction: ReferenceWalletAction): Promise<ReturnType<typeof referenceGasLimits>> {
  if (transaction.chainId !== 296 || transaction.value !== "0x0" ||
      !transaction.nonce || !/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/.test(transaction.nonce)) {
    throw new Error("A nonce-bound Hedera testnet transaction is required for gas preparation");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const values = await Promise.race([
      Promise.all([
        provider.request({ method: "eth_estimateGas", params: [{ from, to: transaction.to,
          data: transaction.data, value: transaction.value, nonce: transaction.nonce }] }),
        provider.request({ method: "eth_gasPrice" }),
        provider.request({ method: "eth_getBalance", params: [from, "pending"] }),
      ]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Wallet gas preflight timed out; no wallet transaction was requested")), 20_000);
      }),
    ]);
    return referenceGasLimits(values[0], values[1], values[2]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
