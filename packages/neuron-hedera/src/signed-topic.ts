import { computeAddress, getAddress, hexlify, keccak256, Signature, SigningKey } from "ethers";

export type SignedTopicEnvelope = Readonly<{
  senderAddress: string;
  timestamp: bigint;
  sequenceNumber: bigint;
  payload: Uint8Array;
  compressedPublicKey: string;
}>;

const maxUint64 = (1n << 64n) - 1n;

function uint64(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Signed topic ${name} must be a canonical uint64 string`);
  }
  const parsed = BigInt(value);
  if (parsed > maxUint64) throw new Error(`Signed topic ${name} exceeds uint64`);
  return parsed;
}

function base64(value: unknown, name: string): Buffer {
  if (typeof value !== "string") throw new Error(`Signed topic ${name} must be base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error(`Signed topic ${name} is not canonical base64`);
  return bytes;
}

export function inspectSignedTopicEnvelope(bytes: Uint8Array): SignedTopicEnvelope | null {
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (!("senderAddress" in row) && !("signature" in row)) return null;
  const keys = Object.keys(row);
  if (keys.join(",") !== "senderAddress,signature,timestamp,sequenceNumber,payload" ||
      JSON.stringify(row) !== Buffer.from(bytes).toString("utf8")) {
    throw new Error("Signed topic envelope is not canonical JSON");
  }
  let senderAddress: string;
  try {
    senderAddress = getAddress(row.senderAddress as string);
  } catch {
    throw new Error("Signed topic sender is not an EIP-55 address");
  }
  if (senderAddress !== row.senderAddress) {
    throw new Error("Signed topic sender is not an EIP-55 address");
  }
  const timestamp = uint64(row.timestamp, "timestamp");
  const sequenceNumber = uint64(row.sequenceNumber, "sequenceNumber");
  if (timestamp === 0n || sequenceNumber === 0n) throw new Error("Signed topic timestamp and sequence must be positive");
  const payload = base64(row.payload, "payload");
  const signatureBytes = base64(row.signature, "signature");
  if (signatureBytes.length !== 65 || signatureBytes[64] > 1) throw new Error("Signed topic signature must be R||S||V with V 0 or 1");
  const preimage = Buffer.allocUnsafe(16 + payload.length);
  preimage.writeBigUInt64BE(timestamp, 0);
  preimage.writeBigUInt64BE(sequenceNumber, 8);
  payload.copy(preimage, 16);
  const digest = keccak256(preimage);
  const signature = Signature.from({
    r: hexlify(signatureBytes.subarray(0, 32)),
    s: hexlify(signatureBytes.subarray(32, 64)),
    v: signatureBytes[64],
  });
  const publicKey = SigningKey.recoverPublicKey(digest, signature);
  if (senderAddress !== computeAddress(publicKey)) {
    throw new Error("Signed topic sender does not match its signature");
  }
  return {
    senderAddress,
    timestamp,
    sequenceNumber,
    payload,
    compressedPublicKey: SigningKey.computePublicKey(publicKey, true).slice(2),
  };
}
