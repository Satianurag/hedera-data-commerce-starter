import { SigningKey, computeAddress, getAddress } from "ethers";
import { getMirrorAccount, getMirrorTopic } from "./mirror.js";
import { assertNetworkConfig, type NetworkConfig } from "./network.js";

/** Operator-pinned discovery, never a directory record or a delivery assertion. */
export type DirectSellerProfile = Readonly<{
  schema: "neuronDirectSeller/v1"; network: "testnet"; chainId: 296;
  accountId: string; publicKey: string; stdinTopicId: string; stdoutTopicId: string;
  quoteTopicId: string; serviceId: "1"; protocol: "neuron/ADSB/0.0.2";
  paymentProtocol: "neuronCustomerQuote/v1";
  transport: "public" | "loopback";
}>;
const keys = ["schema", "network", "chainId", "accountId", "publicKey", "stdinTopicId",
  "stdoutTopicId", "quoteTopicId", "serviceId", "protocol", "paymentProtocol", "transport"].sort();
const hederaId = /^0\.0\.[1-9]\d{0,19}$/;

/** Same literal-address policy as the Go request generator and native seller. */
export function assertSellerUDPAddress(value: string, transport: "public" | "loopback" = "public"): void {
  const match = /^\/ip4\/(\d{1,3}(?:\.\d{1,3}){3})\/udp\/([1-9]\d{0,4})\/quic-v1$/.exec(value);
  if (!match || Number(match[2]) > 65535) throw new Error("Seller UDP address or port is invalid");
  const octets = match[1].split(".").map(Number);
  if (octets.some(part => part > 255) || octets.join(".") !== match[1]) {
    throw new Error("Seller UDP address must use canonical IPv4");
  }
  if (transport === "loopback") {
    if (match[1] !== "127.0.0.1") throw new Error("Loopback seller requires exactly 127.0.0.1");
    return;
  }
  const [a, b, c] = octets;
  if (transport !== "public" || a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) {
    throw new Error("Seller UDP address must be public IPv4");
  }
}

export function parseDirectSellerProfile(value: unknown): DirectSellerProfile {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== keys.join(",")) throw new Error("Invalid direct seller profile fields");
  const row = value as Record<string, unknown>;
  if (row.schema !== "neuronDirectSeller/v1" || row.network !== "testnet" || row.chainId !== 296 ||
      row.serviceId !== "1" || row.protocol !== "neuron/ADSB/0.0.2" ||
      row.paymentProtocol !== "neuronCustomerQuote/v1") throw new Error("Unsupported direct seller protocol or network");
  if (row.transport !== "public" && row.transport !== "loopback") throw new Error("Unsupported direct seller transport");
  for (const name of ["accountId", "stdinTopicId", "stdoutTopicId", "quoteTopicId"]) {
    const id = row[name];
    if (typeof id !== "string" || !hederaId.test(id) || BigInt(id.slice(4)) > 18446744073709551615n) {
      throw new Error("Invalid direct seller Hedera ID");
    }
  }
  if (typeof row.publicKey !== "string" || !/^0[23][0-9a-f]{64}$/.test(row.publicKey) ||
      SigningKey.computePublicKey(`0x${row.publicKey}`, true) !== `0x${row.publicKey}`) {
    throw new Error("Invalid direct seller compressed key");
  }
  if (new Set([row.stdinTopicId, row.stdoutTopicId, row.quoteTopicId]).size !== 3) {
    throw new Error("Direct seller request, heartbeat and quote topics must be distinct");
  }
  return Object.freeze({ ...row }) as DirectSellerProfile;
}


export async function checkDirectSellerBinding(config: NetworkConfig, profile: DirectSellerProfile): Promise<void> {
  assertNetworkConfig(config);
  parseDirectSellerProfile(profile);
  if (config.network !== "testnet" || config.chainId !== profile.chainId) throw new Error("Direct seller is testnet-only");
  const [account, topics] = await Promise.all([getMirrorAccount(config, profile.accountId),
    Promise.all([profile.stdinTopicId, profile.stdoutTopicId, profile.quoteTopicId].map(id => getMirrorTopic(config, id)))]);
  if (account.key?._type !== "ECDSA_SECP256K1" || account.key.key.toLowerCase() !== profile.publicKey ||
      typeof account.evm_address !== "string" || getAddress(account.evm_address) !== computeAddress(`0x${profile.publicKey}`)) {
    throw new Error("Direct seller key or EVM address differs from its pinned identity");
  }
  for (const topic of topics) {
    if (topic.submit_key !== null || !Array.isArray(topic.custom_fees?.fixed_fees) || topic.custom_fees.fixed_fees.length !== 0) {
      throw new Error("Direct seller topics must be open, active and without custom fees");
    }
  }
}
