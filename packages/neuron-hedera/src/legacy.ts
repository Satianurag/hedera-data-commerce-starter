import { createPublicKey } from "node:crypto";
import { getMirrorAccount, getMirrorTopic, readOnlyJson } from "./mirror.js";
import { assertHederaId, assertNetworkConfig, type NetworkConfig } from "./network.js";

export type LegacyDevice = Readonly<{
  accountId: string;
  name: string;
  deviceType: string;
  publicKeyDerHex: string;
  stdinTopicId: string;
  stdoutTopicId: string;
  serviceIds: readonly number[];
}>;

function parseDevice(value: unknown): LegacyDevice {
  if (!value || typeof value !== "object") throw new Error("Invalid legacy device record");
  const row = value as Record<string, unknown>;
  const accountId = row.hederaaccountnumber;
  const stdinTopicId = row.topic_stdin;
  const stdoutTopicId = row.topic_stdout;
  const publicKeyDerHex = row.publickey;
  if (
    typeof accountId !== "string" ||
    typeof stdinTopicId !== "string" ||
    typeof stdoutTopicId !== "string" ||
    typeof publicKeyDerHex !== "string" ||
    typeof row.name !== "string" ||
    typeof row.devicetype !== "string" ||
    !Array.isArray(row.services)
  ) {
    throw new Error("Invalid legacy device record");
  }
  assertHederaId(accountId, "accountId");
  assertHederaId(stdinTopicId, "stdinTopicId");
  assertHederaId(stdoutTopicId, "stdoutTopicId");
  if (!/^(?:[0-9a-f]{2})+$/i.test(publicKeyDerHex)) throw new Error("Invalid device public key");
  const serviceIds = row.services.map((service: unknown) => {
    if (!service || typeof service !== "object") throw new Error("Invalid legacy service");
    const id = (service as Record<string, unknown>).service_id;
    if (!Number.isSafeInteger(id) || (id as number) < 0)
      throw new Error("Invalid legacy service ID");
    return id as number;
  });
  return {
    accountId,
    name: row.name,
    deviceType: row.devicetype,
    publicKeyDerHex,
    stdinTopicId,
    stdoutTopicId,
    serviceIds,
  };
}

export async function listLegacyDevices(config: NetworkConfig): Promise<LegacyDevice[]> {
  assertNetworkConfig(config);
  if (!config.legacyDirectoryUrl)
    throw new Error(`Legacy directory is not configured for ${config.network}`);
  const data = await readOnlyJson(config.legacyDirectoryUrl, "Legacy directory");
  if (!Array.isArray(data)) throw new Error("Legacy directory response is not an array");
  if (data.length > 1000) throw new Error("Legacy directory exceeds 1000 device records");
  return data.map(parseDevice);
}

function compressedKeyFromDer(derHex: string): string {
  const key = createPublicKey({ key: Buffer.from(derHex, "hex"), format: "der", type: "spki" });
  const jwk = key.export({ format: "jwk" });
  if (jwk.crv !== "secp256k1" || !jwk.x || !jwk.y) throw new Error("Device key is not secp256k1");
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  if (x.length !== 32 || y.length !== 32) throw new Error("Invalid secp256k1 public key size");
  return `${y[31] % 2 ? "03" : "02"}${x.toString("hex")}`;
}

export async function checkLegacyDeviceBinding(
  config: NetworkConfig,
  device: LegacyDevice,
): Promise<void> {
  const [account] = await Promise.all([
    getMirrorAccount(config, device.accountId),
    getMirrorTopic(config, device.stdinTopicId),
    getMirrorTopic(config, device.stdoutTopicId),
  ]);
  const expected = compressedKeyFromDer(device.publicKeyDerHex);
  if (account.key?._type !== "ECDSA_SECP256K1" || account.key.key.toLowerCase() !== expected) {
    throw new Error(
      `Legacy directory key does not match Mirror account ${device.accountId} on ${config.network}`,
    );
  }
}
