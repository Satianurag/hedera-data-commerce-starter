import type { HederaNetwork } from "@neuron/hedera";

/** A configured option is only a navigation affordance, never proof of a live stream. */
export function streamOptionSeller(network: HederaNetwork,
    env: Record<string, string | undefined>): string | null {
  if (network !== "testnet" ||
      (env.NEURON_ENABLE_LOCAL_STREAM !== "true" && env.NEURON_ENABLE_REMOTE_STREAM !== "true")) {
    return null;
  }
  const seller = env.NEURON_SELLER_ACCOUNT_ID;
  return seller && /^0\.0\.[1-9]\d{0,18}$/.test(seller) ? seller : null;
}
