export type HederaNetwork = "testnet" | "mainnet";

export type NetworkConfig = Readonly<{
  network: HederaNetwork;
  mirrorBaseUrl: string;
  legacyDirectoryUrl?: string;
}>;

const mirrorUrls: Record<HederaNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet.mirrornode.hedera.com",
};
const testnetDirectoryUrl = "https://explorer.neuron.world/api/v1/device/wip-all";

function httpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url.href.replace(/\/$/, "");
}

export function networkConfigFromEnv(env: Record<string, string | undefined>): NetworkConfig {
  const network = env.HEDERA_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error("HEDERA_NETWORK must be testnet or mainnet");
  }

  const directory = env.NEURON_LEGACY_DIRECTORY_URL ??
    (network === "testnet" ? testnetDirectoryUrl : undefined);
  const config = Object.freeze({
    network,
    mirrorBaseUrl: httpsUrl(env.HEDERA_MIRROR_URL ?? mirrorUrls[network], "HEDERA_MIRROR_URL"),
    ...(directory ? { legacyDirectoryUrl: httpsUrl(directory, "NEURON_LEGACY_DIRECTORY_URL") } : {}),
  });
  assertNetworkConfig(config);
  return config;
}

export function assertNetworkConfig(config: NetworkConfig): void {
  if ((config.network !== "testnet" && config.network !== "mainnet") ||
      config.mirrorBaseUrl !== mirrorUrls[config.network] ||
      config.legacyDirectoryUrl !== (config.network === "testnet" ? testnetDirectoryUrl : undefined)) {
    throw new Error("Mirror or legacy directory is not approved for the selected Hedera network");
  }
}

export function assertHederaId(value: string, label: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${label} must be a Hedera account or topic ID`);
  }
}
