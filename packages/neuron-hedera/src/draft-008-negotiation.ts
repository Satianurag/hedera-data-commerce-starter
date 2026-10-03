import { computeAddress, getAddress } from "ethers";
import { getTopicMessageBySequence, type TopicMessage } from "./hcs.js";
import { getMirrorAccount } from "./mirror.js";
import { assertHederaId, assertNetworkConfig, type NetworkConfig } from "./network.js";
import { inspectSignedTopicEnvelope } from "./signed-topic.js";

// Read-only subset of neuron-specs@13ab01d, 008 FR-P08/P12/P12a. A
// serviceResponse does not carry buyer, service, session, currency, payee,
// nonce, expiry or chain fields. Those MUST be established from a separately
// verified serviceRequest/listing before this response has product meaning.
// Every field below must come from a previously authenticated, persisted
// serviceRequest and local buyer policy. Do not populate it from an untrusted
// browser parameter or treat it as a seller-signed payment quote.
export type Draft008ResponseContext = Readonly<{
  network: "testnet" | "mainnet";
  buyerStdInTopicId: string;
  sellerAccountId: string;
  requestId: string;
  requestConsensusTimestamp: string;
  negotiationDeadlineNanoseconds: bigint;
  nowNanoseconds: bigint;
  /** The request's amount unit must already be verified; this is only a counter ceiling. */
  maxCounterAmount: string;
  /** Persist both values per requestId; pass zero for a request with no prior response. */
  lastHcsSequenceNumber: number;
  lastEnvelopeSequenceNumber: bigint;
}>;

// FR-P07 request fields identify a service *name* and proposed currency. The
// payload does not prove that the seller advertised that service, define the
// currency's base unit/decimals, specify a payee, or bind an escrow contract.
export type Draft008ServiceRequest = Readonly<{
  type: "serviceRequest";
  version: string;
  requestId: string;
  serviceRef: string;
  settlementBinding: string;
  proposedAmount: string;
  proposedCurrency: string;
  proposedInterval: string;
  serviceParams?: Readonly<Record<string, unknown>>;
  negotiationDeadline: string;
  arbiter?: string;
  buyerStdIn: string;
}>;

export type Draft008RequestExpectation = Readonly<{
  sellerStdInTopicId: string;
  buyerAccountId: string;
  buyerStdInTopicId: string;
  requestId: string;
  serviceRef: string;
  settlementBinding: string;
  proposedCurrency: string;
  /** Local ceiling in the selected currency's own unit; no base-unit conversion is inferred. */
  maxProposedAmount: string;
  nowNanoseconds: bigint;
}>;

export type VerifiedDraft008ServiceRequest = Readonly<{
  request: Draft008ServiceRequest;
  network: "testnet" | "mainnet";
  sellerStdInTopicId: string;
  buyerAccountId: string;
  buyerAddress: string;
  hcsSequenceNumber: number;
  envelopeSequenceNumber: bigint;
  consensusTimestamp: string;
  /** Exact signed canonical JSON bytes, preserved as immutable hex text. */
  canonicalPayloadHex: string;
  /** No listing, asset-unit, payee, contract or payment authority is implied. */
  paymentAuthorized: false;
}>;

export type Draft008ServiceResponse = Readonly<{
  type: "serviceResponse";
  version: string;
  requestId: string;
  action: "accept" | "counter" | "reject";
  counterAmount?: string;
  counterInterval?: string;
}>;

export type VerifiedDraft008ServiceResponse = Readonly<{
  response: Draft008ServiceResponse;
  network: "testnet" | "mainnet";
  buyerStdInTopicId: string;
  sellerAccountId: string;
  sellerAddress: string;
  hcsSequenceNumber: number;
  envelopeSequenceNumber: bigint;
  consensusTimestamp: string;
  /** Informational only. This result is never sufficient to fund or release escrow. */
  paymentAuthorized: false;
}>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint64Max = (1n << 64n) - 1n;
const knownFields = ["type", "version", "requestId", "action"];
const counterFields = [...knownFields, "counterAmount", "counterInterval"];
const requestOrder = [
  "type",
  "version",
  "requestId",
  "serviceRef",
  "settlementBinding",
  "proposedAmount",
  "proposedCurrency",
  "proposedInterval",
  "serviceParams",
  "negotiationDeadline",
  "arbiter",
  "buyerStdIn",
];
const requestRequired = requestOrder.filter((key) => key !== "serviceParams" && key !== "arbiter");

function consensusNanoseconds(value: string): bigint {
  if (!/^(0|[1-9]\d*)\.\d{1,9}$/.test(value)) throw new Error("Invalid HCS consensus timestamp");
  const [seconds, fraction] = value.split(".");
  return BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}

function decimal(value: unknown, label: string): [bigint, number] {
  if (typeof value !== "string" || value.length > 80 || !/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a bounded canonical nonnegative decimal string`);
  }
  const [whole, fraction = ""] = value.split(".");
  return [BigInt(whole + fraction), fraction.length];
}

function compareDecimal(
  left: string,
  right: string,
  leftLabel: string,
  rightLabel: string,
): number {
  const [a, aScale] = decimal(left, leftLabel);
  const [b, bScale] = decimal(right, rightLabel);
  const common = Math.max(aScale, bScale);
  const l = a * 10n ** BigInt(common - aScale);
  const r = b * 10n ** BigInt(common - bScale);
  return l < r ? -1 : l > r ? 1 : 0;
}

function uint64(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} must be a canonical uint64 string`);
  }
  const number = BigInt(value);
  if (number > uint64Max) throw new Error(`${label} exceeds uint64`);
  return number;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new Error(`${label} must be a nonempty bounded string`);
  }
  return value;
}

function checkUnknownCanonical(value: unknown): void {
  if (value === null) throw new Error("Draft 008 optional fields cannot be null");
  if (Array.isArray(value)) {
    for (const item of value) checkUnknownCanonical(item);
  } else if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.join(",") !== [...keys].sort().join(","))
      throw new Error("Draft 008 extension keys are not canonical");
    for (const item of Object.values(value)) checkUnknownCanonical(item);
  }
}

function checkSortedObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} keys are not canonical`);
  }
  for (const child of Object.values(value)) checkSortedValue(child, label);
}

function checkSortedValue(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    for (const item of value) checkSortedValue(item, label);
  } else if (value && typeof value === "object") checkSortedObject(value, label);
}

export async function verifyDraft008ServiceRequest(
  config: NetworkConfig,
  message: TopicMessage,
  expected: Draft008RequestExpectation,
): Promise<VerifiedDraft008ServiceRequest> {
  assertNetworkConfig(config);
  assertHederaId(expected.sellerStdInTopicId, "sellerStdInTopicId");
  assertHederaId(expected.buyerAccountId, "buyerAccountId");
  assertHederaId(expected.buyerStdInTopicId, "buyerStdInTopicId");
  if (
    !uuid.test(expected.requestId) ||
    typeof expected.nowNanoseconds !== "bigint" ||
    expected.nowNanoseconds <= 0n ||
    !expected.serviceRef ||
    expected.serviceRef.length > 256 ||
    !expected.settlementBinding ||
    !expected.proposedCurrency
  ) {
    throw new Error("Draft 008 expected request context is invalid");
  }
  decimal(expected.maxProposedAmount, "maxProposedAmount");
  if (
    message.topicId !== expected.sellerStdInTopicId ||
    message.payerAccountId !== expected.buyerAccountId ||
    !Number.isSafeInteger(message.sequenceNumber) ||
    message.sequenceNumber < 1
  ) {
    throw new Error("Draft 008 request HCS topic, payer or sequence does not match the buyer");
  }
  const consensusAt = consensusNanoseconds(message.consensusTimestamp);
  if (consensusAt > expected.nowNanoseconds + 300_000_000_000n) {
    throw new Error("Draft 008 request consensus time is in the future");
  }
  if (message.bytes.length > 8192) throw new Error("Draft 008 request envelope exceeds 8192 bytes");
  const envelope = inspectSignedTopicEnvelope(message.bytes);
  if (!envelope) throw new Error("Draft 008 request lacks a signed TopicMessage");
  const request = parseRequest(envelope.payload);
  if (
    request.requestId !== expected.requestId ||
    request.serviceRef !== expected.serviceRef ||
    request.buyerStdIn !== expected.buyerStdInTopicId ||
    request.settlementBinding !== expected.settlementBinding ||
    request.proposedCurrency !== expected.proposedCurrency ||
    compareDecimal(
      request.proposedAmount,
      expected.maxProposedAmount,
      "proposedAmount",
      "maxProposedAmount",
    ) > 0
  ) {
    throw new Error(
      "Draft 008 request ID, service, binding, currency, amount or buyer inbox does not match the selection",
    );
  }
  // 008 FR-P07 and the pinned Go ServiceRequest encode Unix epoch seconds.
  // Convert once before comparing with signed TopicMessage/HCS nanoseconds.
  const deadline = uint64(request.negotiationDeadline, "negotiationDeadline") * 1_000_000_000n;
  // Pinned Go AgreementStateMachine.CheckDeadline expires only when now > deadline.
  if (
    deadline <= consensusAt ||
    envelope.timestamp > deadline ||
    envelope.timestamp > consensusAt + 300_000_000_000n
  ) {
    throw new Error("Draft 008 request deadline or signed time is invalid");
  }
  const account = await getMirrorAccount(config, expected.buyerAccountId);
  let buyerAddress: string;
  try {
    buyerAddress = getAddress(account.evm_address as string);
  } catch {
    throw new Error("Draft 008 buyer has no valid EVM address");
  }
  if (
    account.key?._type !== "ECDSA_SECP256K1" ||
    account.key.key.toLowerCase() !== envelope.compressedPublicKey.toLowerCase() ||
    computeAddress(`0x${envelope.compressedPublicKey}`) !== buyerAddress ||
    envelope.senderAddress !== buyerAddress
  ) {
    throw new Error("Draft 008 signed request does not match the current buyer key");
  }
  return {
    request,
    network: config.network,
    sellerStdInTopicId: expected.sellerStdInTopicId,
    buyerAccountId: expected.buyerAccountId,
    buyerAddress,
    hcsSequenceNumber: message.sequenceNumber,
    envelopeSequenceNumber: envelope.sequenceNumber,
    consensusTimestamp: message.consensusTimestamp,
    canonicalPayloadHex: `0x${Buffer.from(envelope.payload).toString("hex")}`,
    paymentAuthorized: false,
  };
}

export async function getVerifiedDraft008ServiceRequest(
  config: NetworkConfig,
  finalHcsSequenceNumber: number,
  expected: Draft008RequestExpectation,
): Promise<VerifiedDraft008ServiceRequest> {
  const message = await getTopicMessageBySequence(
    config,
    expected.sellerStdInTopicId,
    finalHcsSequenceNumber,
  );
  return verifyDraft008ServiceRequest(config, message, expected);
}

export function draft008ResponseContextFromRequest(
  verified: VerifiedDraft008ServiceRequest,
  local: Readonly<{
    sellerAccountId: string;
    maxCounterAmount: string;
    nowNanoseconds: bigint;
    lastHcsSequenceNumber: number;
    lastEnvelopeSequenceNumber: bigint;
  }>,
): Draft008ResponseContext {
  assertHederaId(local.sellerAccountId, "sellerAccountId");
  decimal(local.maxCounterAmount, "maxCounterAmount");
  if (verified.paymentAuthorized !== false)
    throw new Error("Draft 008 request is not a payment authorization");
  return {
    network: verified.network,
    buyerStdInTopicId: verified.request.buyerStdIn,
    sellerAccountId: local.sellerAccountId,
    requestId: verified.request.requestId,
    requestConsensusTimestamp: verified.consensusTimestamp,
    negotiationDeadlineNanoseconds:
      uint64(verified.request.negotiationDeadline, "negotiationDeadline") * 1_000_000_000n,
    nowNanoseconds: local.nowNanoseconds,
    maxCounterAmount: local.maxCounterAmount,
    lastHcsSequenceNumber: local.lastHcsSequenceNumber,
    lastEnvelopeSequenceNumber: local.lastEnvelopeSequenceNumber,
  };
}

function parseRequest(payload: Uint8Array): Draft008ServiceRequest {
  if (payload.length > 4096) throw new Error("Draft 008 request payload exceeds 4096 bytes");
  let encoded: string;
  let parsed: unknown;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("Draft 008 request is not UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Draft 008 request must be an object");
  }
  const row = parsed as Record<string, unknown>;
  if (
    JSON.stringify(row) !== encoded ||
    typeof row.version !== "string" ||
    !/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(row.version)
  ) {
    throw new Error("Draft 008 request is noncanonical or has an unsupported version");
  }
  if (
    row.type !== "serviceRequest" ||
    typeof row.requestId !== "string" ||
    !uuid.test(row.requestId)
  ) {
    throw new Error("Draft 008 request has invalid type or requestId");
  }
  const keys = Object.keys(row);
  const presentKnown = requestOrder.filter((key) => Object.hasOwn(row, key));
  if (
    requestRequired.some((key) => !Object.hasOwn(row, key)) ||
    keys.slice(0, presentKnown.length).join(",") !== presentKnown.join(",") ||
    (row.version === "1.0.0" && keys.length !== presentKnown.length)
  ) {
    throw new Error("Draft 008 request fields are missing or noncanonical");
  }
  const extra = keys.slice(presentKnown.length);
  if (
    extra.some((key) => requestOrder.includes(key)) ||
    extra.join(",") !== [...extra].sort().join(",")
  ) {
    throw new Error("Draft 008 request extension fields are noncanonical");
  }
  for (const key of extra) checkUnknownCanonical(row[key]);
  const serviceRef = nonempty(row.serviceRef, "serviceRef");
  const settlementBinding = nonempty(row.settlementBinding, "settlementBinding");
  const proposedCurrency = nonempty(row.proposedCurrency, "proposedCurrency");
  const [amount] = decimal(row.proposedAmount, "proposedAmount");
  if (amount === 0n) throw new Error("Draft 008 proposedAmount must be positive");
  uint64(row.proposedInterval, "proposedInterval");
  uint64(row.negotiationDeadline, "negotiationDeadline");
  assertHederaId(row.buyerStdIn as string, "buyerStdIn");
  if (Object.hasOwn(row, "serviceParams")) checkSortedObject(row.serviceParams, "serviceParams");
  if (Object.hasOwn(row, "arbiter")) nonempty(row.arbiter, "arbiter");
  return {
    type: "serviceRequest",
    version: row.version,
    requestId: row.requestId,
    serviceRef,
    settlementBinding,
    proposedAmount: row.proposedAmount as string,
    proposedCurrency,
    proposedInterval: row.proposedInterval as string,
    ...(Object.hasOwn(row, "serviceParams")
      ? { serviceParams: row.serviceParams as Record<string, unknown> }
      : {}),
    negotiationDeadline: row.negotiationDeadline as string,
    ...(Object.hasOwn(row, "arbiter") ? { arbiter: row.arbiter as string } : {}),
    buyerStdIn: row.buyerStdIn as string,
  };
}

function parseResponse(payload: Uint8Array): Draft008ServiceResponse {
  if (payload.length > 4096) throw new Error("Draft 008 response payload exceeds 4096 bytes");
  let encoded: string;
  let parsed: unknown;
  try {
    encoded = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("Draft 008 response is not UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Draft 008 response must be an object");
  const row = parsed as Record<string, unknown>;
  if (
    JSON.stringify(row) !== encoded ||
    typeof row.version !== "string" ||
    !/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(row.version)
  ) {
    throw new Error("Draft 008 response is noncanonical or has an unsupported version");
  }
  if (
    row.type !== "serviceResponse" ||
    typeof row.requestId !== "string" ||
    !uuid.test(row.requestId) ||
    (row.action !== "accept" && row.action !== "counter" && row.action !== "reject")
  ) {
    throw new Error("Draft 008 response has invalid required fields");
  }
  const keys = Object.keys(row);
  const base = row.action === "counter" ? counterFields : knownFields;
  if (
    keys.slice(0, base.length).join(",") !== base.join(",") ||
    (row.version === "1.0.0" && keys.length !== base.length)
  ) {
    throw new Error("Draft 008 response fields are not in canonical order");
  }
  const extra = keys.slice(base.length);
  if (
    extra.some((key) => counterFields.includes(key)) ||
    extra.join(",") !== [...extra].sort().join(",")
  ) {
    throw new Error("Draft 008 extension keys are not canonical");
  }
  for (const key of extra) checkUnknownCanonical(row[key]);
  if (row.action === "counter") {
    const [amount] = decimal(row.counterAmount, "counterAmount");
    if (
      amount === 0n ||
      typeof row.counterInterval !== "string" ||
      !/^(0|[1-9]\d*)$/.test(row.counterInterval) ||
      BigInt(row.counterInterval) > uint64Max
    ) {
      throw new Error("Draft 008 counter amount or interval is invalid");
    }
  }
  return {
    type: "serviceResponse",
    version: row.version,
    requestId: row.requestId,
    action: row.action,
    ...(row.action === "counter"
      ? {
          counterAmount: row.counterAmount as string,
          counterInterval: row.counterInterval as string,
        }
      : {}),
  };
}

export async function verifyDraft008ServiceResponse(
  config: NetworkConfig,
  message: TopicMessage,
  context: Draft008ResponseContext,
): Promise<VerifiedDraft008ServiceResponse> {
  assertNetworkConfig(config);
  if (context.network !== config.network)
    throw new Error("Draft 008 request and response networks do not match");
  assertHederaId(context.buyerStdInTopicId, "buyerStdInTopicId");
  assertHederaId(context.sellerAccountId, "sellerAccountId");
  if (
    !uuid.test(context.requestId) ||
    !Number.isSafeInteger(context.lastHcsSequenceNumber) ||
    context.lastHcsSequenceNumber < 0 ||
    typeof context.lastEnvelopeSequenceNumber !== "bigint" ||
    context.lastEnvelopeSequenceNumber < 0n ||
    context.lastEnvelopeSequenceNumber > uint64Max ||
    typeof context.nowNanoseconds !== "bigint" ||
    typeof context.negotiationDeadlineNanoseconds !== "bigint" ||
    context.nowNanoseconds <= 0n ||
    context.negotiationDeadlineNanoseconds <= 0n
  ) {
    throw new Error("Draft 008 verified request context is invalid");
  }
  const requestedAt = consensusNanoseconds(context.requestConsensusTimestamp);
  if (
    context.negotiationDeadlineNanoseconds <= requestedAt ||
    context.nowNanoseconds > context.negotiationDeadlineNanoseconds
  ) {
    throw new Error("Draft 008 negotiation deadline has expired");
  }
  decimal(context.maxCounterAmount, "maxCounterAmount");
  if (
    message.topicId !== context.buyerStdInTopicId ||
    message.payerAccountId !== context.sellerAccountId ||
    !Number.isSafeInteger(message.sequenceNumber) ||
    message.sequenceNumber <= context.lastHcsSequenceNumber
  ) {
    throw new Error("Draft 008 response topic, payer or HCS sequence mismatches or replays");
  }
  const consensusAt = consensusNanoseconds(message.consensusTimestamp);
  if (
    consensusAt < requestedAt ||
    consensusAt > context.negotiationDeadlineNanoseconds ||
    consensusAt > context.nowNanoseconds + 300_000_000_000n
  ) {
    throw new Error("Draft 008 response consensus time is outside the request window");
  }
  if (message.bytes.length > 8192)
    throw new Error("Draft 008 response envelope exceeds 8192 bytes");
  const envelope = inspectSignedTopicEnvelope(message.bytes);
  if (!envelope || envelope.sequenceNumber <= context.lastEnvelopeSequenceNumber) {
    throw new Error("Draft 008 response is unsigned or replays a signed sequence");
  }
  if (
    envelope.timestamp < requestedAt ||
    envelope.timestamp > context.negotiationDeadlineNanoseconds ||
    envelope.timestamp > consensusAt + 300_000_000_000n
  ) {
    throw new Error("Draft 008 signed response time is outside the request window");
  }
  const response = parseResponse(envelope.payload);
  if (response.requestId !== context.requestId)
    throw new Error("Draft 008 response requestId does not match");
  if (
    response.action === "counter" &&
    compareDecimal(
      response.counterAmount!,
      context.maxCounterAmount,
      "counterAmount",
      "maxCounterAmount",
    ) > 0
  ) {
    throw new Error("Draft 008 counter exceeds the verified request ceiling");
  }
  const account = await getMirrorAccount(config, context.sellerAccountId);
  let sellerAddress: string;
  try {
    sellerAddress = getAddress(account.evm_address as string);
  } catch {
    throw new Error("Draft 008 seller has no valid EVM address");
  }
  if (
    account.key?._type !== "ECDSA_SECP256K1" ||
    account.key.key.toLowerCase() !== envelope.compressedPublicKey.toLowerCase() ||
    computeAddress(`0x${envelope.compressedPublicKey}`) !== sellerAddress ||
    envelope.senderAddress !== sellerAddress
  ) {
    throw new Error("Draft 008 signed response does not match the current seller key");
  }
  return {
    response,
    network: config.network,
    buyerStdInTopicId: context.buyerStdInTopicId,
    sellerAccountId: context.sellerAccountId,
    sellerAddress,
    hcsSequenceNumber: message.sequenceNumber,
    envelopeSequenceNumber: envelope.sequenceNumber,
    consensusTimestamp: message.consensusTimestamp,
    paymentAuthorized: false,
  };
}

export async function getVerifiedDraft008ServiceResponse(
  config: NetworkConfig,
  finalHcsSequenceNumber: number,
  context: Draft008ResponseContext,
): Promise<VerifiedDraft008ServiceResponse> {
  const message = await getTopicMessageBySequence(
    config,
    context.buyerStdInTopicId,
    finalHcsSequenceNumber,
  );
  return verifyDraft008ServiceResponse(config, message, context);
}
