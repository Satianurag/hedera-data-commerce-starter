import { computeAddress, getAddress, keccak256 } from "ethers";
import { getMirrorAccount } from "./mirror.js";
import { assertHederaId, assertNetworkConfig, type NetworkConfig } from "./network.js";
import { inspectSignedTopicEnvelope } from "./signed-topic.js";
import { getTopicMessageBySequence } from "./hcs.js";
import type { TopicMessage } from "./hcs.js";

// Starter-specific terms, not the draft Neuron 008 invoice wire format. A seller
// must explicitly publish these bytes in a signed TopicMessage before use.
export type SellerQuote = Readonly<{
  type: "neuronCustomerQuote";
  version: "1";
  network: "testnet";
  chainId: "296";
  sellerAccountId: string;
  sellerAddress: string;
  buyerAddress: string;
  serviceId: string;
  sessionId: string;
  asset: "HBAR";
  amountTinybar: string;
  maxAmountTinybar: string;
  durationSeconds: string;
  issuedAt: string;
  expiresAt: string;
  refundAfter: string;
  escrowContractId: string;
  escrowAddress: string;
  evidenceTopicId: string;
  nonce: string;
}>;

export type VerifiedSellerQuote = Readonly<{
  terms: SellerQuote;
  termsHash: string;
  topicId: string;
  sequenceNumber: number;
  sellerPublicKey: string;
}>;

export type QuoteExpectation = Readonly<{
  sellerAccountId: string;
  sellerTopicId: string;
  buyerAddress: string;
  serviceId: string;
  sessionId: string;
  escrowContractId: string;
  escrowAddress: string;
  evidenceTopicId: string;
  maxSpendTinybar: bigint;
  nowSeconds: bigint;
}>;

const fields = ["type", "version", "network", "chainId", "sellerAccountId", "sellerAddress", "buyerAddress",
  "serviceId", "sessionId", "asset", "amountTinybar", "maxAmountTinybar", "durationSeconds", "issuedAt",
  "expiresAt", "refundAfter", "escrowContractId", "escrowAddress", "evidenceTopicId", "nonce"];
const maxUint64 = (1n << 64n) - 1n;

function decimal(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be a canonical integer string`);
  const number = BigInt(value);
  if (number > maxUint64) throw new Error(`${name} exceeds uint64`);
  return number;
}

function address(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be an EIP-55 address`);
  try {
    const normalized = getAddress(value);
    if (normalized !== value) throw new Error("checksum mismatch");
    return normalized;
  } catch { throw new Error(`${name} must be an EIP-55 address`); }
}

function parseQuote(payload: Uint8Array): SellerQuote {
  if (payload.length > 4096) throw new Error("Signed quote payload exceeds 4096 bytes");
  let parsed: unknown;
  const encoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  try { parsed = JSON.parse(encoded); } catch { throw new Error("Signed quote is not JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Signed quote is not an object");
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).join(",") !== fields.join(",") || JSON.stringify(row) !== encoded) {
    throw new Error("Signed quote is not canonical or has unsupported fields");
  }
  if (fields.some(field => typeof row[field] !== "string")) throw new Error("Signed quote fields must be strings");
  return row as SellerQuote;
}

export async function verifySignedSellerQuote(
  config: NetworkConfig, message: TopicMessage, expected: QuoteExpectation,
): Promise<VerifiedSellerQuote> {
  assertNetworkConfig(config);
  if (config.network !== "testnet") throw new Error("Signed quote checkout is testnet-only pending a mainnet release gate");
  if (message.topicId !== expected.sellerTopicId || message.payerAccountId !== expected.sellerAccountId ||
      !Number.isSafeInteger(message.sequenceNumber) || message.sequenceNumber < 1) {
    throw new Error("Quote HCS topic, sequence or payer does not match the seller");
  }
  for (const [name, id] of [["sellerAccountId", expected.sellerAccountId], ["sellerTopicId", expected.sellerTopicId],
    ["escrowContractId", expected.escrowContractId], ["evidenceTopicId", expected.evidenceTopicId]] as const) {
    assertHederaId(id, name);
  }
  if (expected.maxSpendTinybar <= 0n || expected.nowSeconds <= 0n) throw new Error("Buyer cap and clock must be positive");
  if (message.bytes.length > 8192) throw new Error("Signed quote envelope exceeds 8192 bytes");
  const envelope = inspectSignedTopicEnvelope(message.bytes);
  if (!envelope) throw new Error("Seller quote has no signed TopicMessage envelope");
  const quote = parseQuote(envelope.payload);
  if (quote.type !== "neuronCustomerQuote" || quote.version !== "1" || quote.network !== config.network ||
      quote.chainId !== String(config.chainId) || quote.asset !== "HBAR") {
    throw new Error("Unsupported quote type, version, network, chain or asset");
  }
  if (quote.sellerAccountId !== expected.sellerAccountId || quote.serviceId !== expected.serviceId ||
      quote.sessionId !== expected.sessionId || quote.escrowContractId !== expected.escrowContractId ||
      quote.evidenceTopicId !== expected.evidenceTopicId ||
      address(quote.escrowAddress, "escrowAddress") !== address(expected.escrowAddress, "expected escrowAddress") ||
      address(quote.buyerAddress, "buyerAddress") !== address(expected.buyerAddress, "expected buyerAddress")) {
    throw new Error("Seller quote does not match requested buyer, service, session or contract");
  }
  assertHederaId(quote.sellerAccountId, "sellerAccountId");
  assertHederaId(quote.escrowContractId, "escrowContractId");
  assertHederaId(quote.evidenceTopicId, "evidenceTopicId");
  if (!/^[0-9a-f]{64}$/.test(quote.nonce)) throw new Error("Quote nonce must be 32 lowercase hex bytes");
  if (!quote.serviceId || quote.serviceId.length > 128 || !quote.sessionId || quote.sessionId.length > 128) {
    throw new Error("Service and session IDs must be bounded and nonempty");
  }
  const amount = decimal(quote.amountTinybar, "amountTinybar");
  const maximum = decimal(quote.maxAmountTinybar, "maxAmountTinybar");
  const duration = decimal(quote.durationSeconds, "durationSeconds");
  const issued = decimal(quote.issuedAt, "issuedAt");
  const expires = decimal(quote.expiresAt, "expiresAt");
  const refund = decimal(quote.refundAfter, "refundAfter");
  if (!amount || amount > maximum || maximum > expected.maxSpendTinybar || duration < 1n || duration > 86400n ||
      issued > expected.nowSeconds + 300n || expires <= expected.nowSeconds || expires > issued + 3600n ||
      refund < expires + duration || refund > expected.nowSeconds + 30n * 86400n ||
      envelope.timestamp / 1_000_000_000n > expected.nowSeconds + 300n ||
      envelope.timestamp / 1_000_000_000n + 300n < issued) {
    throw new Error("Quote amount, cap, duration or time window is invalid");
  }
  const consensusSeconds = decimal(message.consensusTimestamp.split(".")[0], "consensus timestamp");
  if (consensusSeconds + 300n < issued || consensusSeconds > expires || consensusSeconds > expected.nowSeconds + 300n) {
    throw new Error("Quote consensus time is outside its validity window");
  }
  const account = await getMirrorAccount(config, quote.sellerAccountId);
  const sellerAddress = address(quote.sellerAddress, "sellerAddress");
  if (account.key?._type !== "ECDSA_SECP256K1" ||
      account.key.key.toLowerCase() !== envelope.compressedPublicKey.toLowerCase() ||
      typeof account.evm_address !== "string" ||
      address(account.evm_address, "seller account EVM address") !== sellerAddress ||
      computeAddress(`0x${envelope.compressedPublicKey}`) !== sellerAddress ||
      envelope.senderAddress !== sellerAddress || sellerAddress === quote.buyerAddress) {
    throw new Error("Signed quote key or address does not match the current seller account");
  }
  return { terms: quote, termsHash: keccak256(envelope.payload), topicId: message.topicId,
    sequenceNumber: message.sequenceNumber, sellerPublicKey: envelope.compressedPublicKey };
}

export async function getVerifiedSellerQuote(
  config: NetworkConfig, sellerTopicId: string, finalSequenceNumber: number, expected: QuoteExpectation,
): Promise<VerifiedSellerQuote> {
  if (sellerTopicId !== expected.sellerTopicId) throw new Error("Quote topic does not match selected seller");
  const message = await getTopicMessageBySequence(config, sellerTopicId, finalSequenceNumber);
  return verifySignedSellerQuote(config, message, expected);
}

export function confirmEscrowFunding(verified: VerifiedSellerQuote, buyer: string, confirmation: string): Readonly<{
  seller: string; refundAfter: bigint; termsHash: string; valueWei: bigint;
}> {
  if (address(buyer, "buyer") !== verified.terms.buyerAddress || confirmation !== verified.termsHash) {
    throw new Error("Buyer must explicitly confirm this exact signed terms hash");
  }
  // Hedera JSON-RPC uses 18 EVM decimals while native HBAR has 8 tinybar decimals.
  return { seller: verified.terms.sellerAddress, refundAfter: BigInt(verified.terms.refundAfter),
    termsHash: verified.termsHash, valueWei: BigInt(verified.terms.amountTinybar) * 10_000_000_000n };
}
