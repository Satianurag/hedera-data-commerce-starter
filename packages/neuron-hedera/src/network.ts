export type HederaNetwork = "testnet" | "mainnet";

export type NetworkConfig = Readonly<{
  network: HederaNetwork;
  chainId: 295 | 296;
  mirrorBaseUrl: string;
  /** Server-side EVM relay. Absent until a provider is explicitly configured. */
  rpcUrl?: string;
  legacyDirectoryUrl?: string;
}>;

const mirrorUrls: Record<HederaNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet.mirrornode.hedera.com",
};
const chainIds = { testnet: 296, mainnet: 295 } as const;
const testnetDirectoryUrl = "https://explorer.neuron.world/api/v1/device/wip-all";

function httpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url.href.replace(/\/$/, "");
}

function rpcUrlForNetwork(value: string, network: HederaNetwork): string {
  const canonical = httpsUrl(value, "HEDERA_RPC_URL");
  if (network === "mainnet") {
    const hostname = new URL(canonical).hostname.toLowerCase().replace(/\.$/, "");
    if (hostname.endsWith(".hashio.io") || hostname === "localhost" ||
        hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
        /^[0-9.]+$/.test(hostname) || hostname.startsWith("[")) {
      throw new Error("HEDERA_RPC_URL requires a named production provider on mainnet");
    }
  }
  return canonical;
}

export function networkConfigFromEnv(env: Record<string, string | undefined>): NetworkConfig {
  const network = env.HEDERA_NETWORK ?? "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error("HEDERA_NETWORK must be testnet or mainnet");
  }
  if (env.HEDERA_CHAIN_ID && env.HEDERA_CHAIN_ID !== String(chainIds[network])) {
    throw new Error("HEDERA_CHAIN_ID does not match the selected Hedera network");
  }

  const directory = env.NEURON_LEGACY_DIRECTORY_URL ??
    (network === "testnet" ? testnetDirectoryUrl : undefined);
  const rpc = env.HEDERA_RPC_URL;
  const rpcUrl = rpc ? rpcUrlForNetwork(rpc, network) : undefined;
  const config = Object.freeze({
    network,
    chainId: chainIds[network],
    mirrorBaseUrl: httpsUrl(env.HEDERA_MIRROR_URL ?? mirrorUrls[network], "HEDERA_MIRROR_URL"),
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(directory ? { legacyDirectoryUrl: httpsUrl(directory, "NEURON_LEGACY_DIRECTORY_URL") } : {}),
  });
  assertNetworkConfig(config);
  return config;
}

export function assertNetworkConfig(config: NetworkConfig): void {
  if ((config.network !== "testnet" && config.network !== "mainnet") ||
      config.chainId !== chainIds[config.network] ||
      config.mirrorBaseUrl !== mirrorUrls[config.network] ||
      (config.rpcUrl !== undefined && rpcUrlForNetwork(config.rpcUrl, config.network) !== config.rpcUrl) ||
      config.legacyDirectoryUrl !== (config.network === "testnet" ? testnetDirectoryUrl : undefined)) {
    throw new Error("Mirror, EVM RPC or legacy directory is not approved for the selected Hedera network");
  }
}

/** Check the relay's reported chain before constructing a signer or submitting an EVM transaction. */
export async function assertEvmRpcNetwork(config: NetworkConfig): Promise<void> {
  assertNetworkConfig(config);
  if (!config.rpcUrl) throw new Error(`No EVM RPC is configured for ${config.network}`);
  const response = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`EVM RPC chain preflight returned HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("EVM RPC chain preflight returned no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) {
      await reader.cancel();
      throw new Error("EVM RPC chain preflight response is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("EVM RPC chain preflight returned invalid JSON");
  }
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      (result as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
      (result as { id?: unknown }).id !== 1 ||
      (result as { result?: unknown }).result !== `0x${config.chainId.toString(16)}`) {
    throw new Error(`EVM RPC chain does not match ${config.network}`);
  }
}

export function assertHederaId(value: string, label: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`${label} must be a Hedera account or topic ID`);
  }
}
