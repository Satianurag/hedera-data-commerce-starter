import assert from "node:assert/strict";
import test from "node:test";
import { computeAddress, keccak256, Signature, SigningKey } from "ethers";
import { networkConfigFromEnv } from "../dist/network.js";
import { draft008ResponseContextFromRequest, verifyDraft008ServiceRequest,
  verifyDraft008ServiceResponse } from "../dist/draft-008-negotiation.js";

// Pinned neuron-specs@13ab01d, 008 FR-P08/P12/P12a and 006 FR-W01..W05.
const key = new SigningKey(`0x${"01".padStart(64, "0")}`);
const sellerAddress = computeAddress(key.publicKey);
const buyerKey = new SigningKey(`0x${"02".padStart(64, "0")}`);
const buyerAddress = computeAddress(buyerKey.publicKey);
const testnet = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
const requestId = "550e8400-e29b-41d4-a716-446655440000";
const requestAt = 1_790_410_000n * 1_000_000_000n;
const context = {
  network: "testnet", buyerStdInTopicId: "0.0.10", sellerAccountId: "0.0.7", requestId,
  requestConsensusTimestamp: "1790410000.000000000",
  negotiationDeadlineNanoseconds: requestAt + 300_000_000_000n,
  nowNanoseconds: requestAt + 100_000_000_000n,
  maxCounterAmount: "10.25", lastHcsSequenceNumber: 0,
  lastEnvelopeSequenceNumber: 0n,
};
const accepted = { type: "serviceResponse", version: "1.0.0", requestId, action: "accept" };
const request = {
  type: "serviceRequest", version: "1.0.0", requestId, serviceRef: "adsb-v0.1",
  settlementBinding: "evm-escrow", proposedAmount: "10.00", proposedCurrency: "USDC",
  proposedInterval: "3600", serviceParams: { area: "VVTS", filters: [{ a: 1, b: 2 }] },
  negotiationDeadline: "1790410300", buyerStdIn: "0.0.10",
};
const requestExpected = {
  sellerStdInTopicId: "0.0.12", buyerAccountId: "0.0.9", buyerStdInTopicId: "0.0.10",
  requestId, serviceRef: "adsb-v0.1", settlementBinding: "evm-escrow",
  proposedCurrency: "USDC", maxProposedAmount: "10.00",
  nowNanoseconds: requestAt + 100_000_000_000n,
};

function message(payload = accepted, changes = {}) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const timestamp = requestAt + 90_000_000_000n;
  const preimage = Buffer.alloc(16 + bytes.length);
  preimage.writeBigUInt64BE(timestamp, 0);
  preimage.writeBigUInt64BE(1n, 8);
  bytes.copy(preimage, 16);
  const signed = key.sign(keccak256(preimage));
  const signature = Buffer.concat([
    Buffer.from(signed.r.slice(2), "hex"), Buffer.from(signed.s.slice(2), "hex"),
    Buffer.from([Signature.from(signed).yParity]),
  ]);
  const envelope = Buffer.from(JSON.stringify({
    senderAddress: sellerAddress, signature: signature.toString("base64"),
    timestamp: String(timestamp), sequenceNumber: "1", payload: bytes.toString("base64"),
  }));
  return { topicId: "0.0.10", payerAccountId: "0.0.7",
    consensusTimestamp: "1790410091.000000000", sequenceNumber: 4,
    initialTransactionId: null, bytes: envelope, ...changes };
}

function requestMessage(payload = request, changes = {}) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const timestamp = requestAt + 1_000_000_000n;
  const preimage = Buffer.alloc(16 + bytes.length);
  preimage.writeBigUInt64BE(timestamp, 0);
  preimage.writeBigUInt64BE(2n, 8);
  bytes.copy(preimage, 16);
  const signed = buyerKey.sign(keccak256(preimage));
  const signature = Buffer.concat([
    Buffer.from(signed.r.slice(2), "hex"), Buffer.from(signed.s.slice(2), "hex"),
    Buffer.from([Signature.from(signed).yParity]),
  ]);
  return {
    topicId: "0.0.12", payerAccountId: "0.0.9",
    consensusTimestamp: "1790410002.000000000", sequenceNumber: 11,
    initialTransactionId: null, bytes: Buffer.from(JSON.stringify({
      senderAddress: buyerAddress, signature: signature.toString("base64"),
      timestamp: String(timestamp), sequenceNumber: "2", payload: bytes.toString("base64"),
    })), ...changes,
  };
}

function withSellerMirror(run, mirrorKey = key.compressedPublicKey.slice(2)) {
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(new URL(url).host, "testnet.mirrornode.hedera.com");
    assert.equal(new URL(url).pathname, "/api/v1/accounts/0.0.7");
    return Response.json({ account: "0.0.7", deleted: false,
      evm_address: sellerAddress.toLowerCase(),
      key: { _type: "ECDSA_SECP256K1", key: mirrorKey } });
  };
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = previous; });
}

function withBuyerMirror(run, mirrorKey = buyerKey.compressedPublicKey.slice(2)) {
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(new URL(url).host, "testnet.mirrornode.hedera.com");
    assert.equal(new URL(url).pathname, "/api/v1/accounts/0.0.9");
    return Response.json({ account: "0.0.9", deleted: false,
      evm_address: buyerAddress.toLowerCase(),
      key: { _type: "ECDSA_SECP256K1", key: mirrorKey } });
  };
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = previous; });
}

test("signed draft-008 request preserves canonical bytes and derives response correlation, never payment terms", async () => {
  await withBuyerMirror(async () => {
    const verified = await verifyDraft008ServiceRequest(testnet, requestMessage(), requestExpected);
    assert.equal(verified.buyerAddress, buyerAddress);
    assert.equal(verified.request.proposedAmount, "10.00");
    assert.equal(verified.request.negotiationDeadline, "1790410300");
    assert.equal(verified.canonicalPayloadHex, `0x${Buffer.from(JSON.stringify(request)).toString("hex")}`);
    assert.equal(verified.paymentAuthorized, false);
    assert.equal(Object.hasOwn(verified, "payee"), false);
    assert.deepEqual(draft008ResponseContextFromRequest(verified, {
      sellerAccountId: "0.0.7", maxCounterAmount: "10.00",
      nowNanoseconds: context.nowNanoseconds,
      lastHcsSequenceNumber: 0, lastEnvelopeSequenceNumber: 0n,
    }), { ...context, maxCounterAmount: "10.00", requestConsensusTimestamp: "1790410002.000000000" });
  });
});

test("request signed envelope, buyer payer/key, seller topic, request ID, service and inbox fail closed", async () => {
  const cases = [
    [requestMessage(request, { topicId: "0.0.13" }), requestExpected],
    [requestMessage(request, { payerAccountId: "0.0.8" }), requestExpected],
    [requestMessage({ ...request, requestId: "550e8400-e29b-41d4-a716-446655440001" }), requestExpected],
    [requestMessage({ ...request, serviceRef: "other" }), requestExpected],
    [requestMessage({ ...request, settlementBinding: "hedera-native" }), requestExpected],
    [requestMessage({ ...request, proposedCurrency: "HBAR" }), requestExpected],
    [requestMessage({ ...request, proposedAmount: "10.01" }), requestExpected],
    [requestMessage({ ...request, buyerStdIn: "0.0.99" }), requestExpected],
    [requestMessage({ ...request, negotiationDeadline: "1790410002" }), requestExpected],
  ];
  for (const [signed, expected] of cases) {
    await assert.rejects(verifyDraft008ServiceRequest(testnet, signed, expected));
  }
  await withBuyerMirror(async () => {
    await assert.rejects(verifyDraft008ServiceRequest(testnet, requestMessage(), requestExpected), /current buyer key/);
  }, "02" + "00".repeat(32));
  const tampered = requestMessage();
  const envelope = JSON.parse(Buffer.from(tampered.bytes).toString());
  envelope.payload = Buffer.from(JSON.stringify({ ...request, proposedAmount: "1" })).toString("base64");
  await assert.rejects(verifyDraft008ServiceRequest(testnet,
    { ...tampered, bytes: Buffer.from(JSON.stringify(envelope)) }, requestExpected), /signature/);
});

test("request canonical order, required fields, decimal string and recursively sorted params are enforced", async () => {
  const bad = [
    { ...request, proposedAmount: 10 },
    { ...request, proposedAmount: "01.00" },
    { ...request, negotiationDeadline: 1790410300 },
    { ...request, buyerStdIn: null },
    { ...request, version: "2.0.0" },
    { ...request, serviceParams: { b: 2, a: 1 } },
    { ...request, serviceParams: { filters: [[{ b: 2, a: 1 }]] } },
    { ...request, sellerPayee: sellerAddress },
    (() => { const { buyerStdIn, ...rest } = request; return rest; })(),
    (() => { const { type, ...rest } = request; return { ...rest, type }; })(),
  ];
  for (const payload of bad) {
    await assert.rejects(verifyDraft008ServiceRequest(testnet, requestMessage(payload), requestExpected));
  }
  await withBuyerMirror(async () => {
    const extended = await verifyDraft008ServiceRequest(testnet,
      requestMessage({ ...request, version: "1.1.0", extraFlag: true }), requestExpected);
    assert.equal(extended.request.version, "1.1.0");
    assert.equal(Object.hasOwn(extended.request, "extraFlag"), false);
  });
});

test("accept and reject authenticate the seller but never authorize payment", async () => {
  await withSellerMirror(async () => {
    for (const action of ["accept", "reject"]) {
      const verified = await verifyDraft008ServiceResponse(testnet, message({ ...accepted, action }), context);
      assert.equal(verified.response.action, action);
      assert.equal(verified.response.requestId, requestId);
      assert.equal(verified.network, "testnet");
      assert.equal(verified.sellerAddress, sellerAddress);
      assert.equal(verified.paymentAuthorized, false);
    }
  });
});

test("counter supports decimal price and one-time interval within caller's verified unit cap", async () => {
  const counter = { ...accepted, action: "counter", counterAmount: "10.25", counterInterval: "0" };
  await withSellerMirror(async () => {
    const verified = await verifyDraft008ServiceResponse(testnet, message(counter), context);
    assert.equal(verified.response.counterAmount, "10.25");
    assert.equal(verified.response.counterInterval, "0");
    const trailingZeros = await verifyDraft008ServiceResponse(testnet,
      message({ ...counter, counterAmount: "10.2500" }), context);
    assert.equal(trailingZeros.response.counterAmount, "10.2500");
    await assert.rejects(verifyDraft008ServiceResponse(testnet,
      message({ ...counter, counterAmount: "10.26" }), context), /ceiling/);
  });
});

test("a signed HCS response cannot cross topics, sellers, requests, deadlines or persisted replay cursors", async () => {
  const cases = [
    [message(accepted, { topicId: "0.0.11" }), context, /topic/],
    [message(accepted, { payerAccountId: "0.0.8" }), context, /payer/],
    [message({ ...accepted, requestId: "550e8400-e29b-41d4-a716-446655440001" }), context, /requestId/],
    [message(), { ...context, lastHcsSequenceNumber: 4 }, /replays/],
    [message(), { ...context, lastEnvelopeSequenceNumber: 1n }, /replays/],
    [message(), { ...context, nowNanoseconds: requestAt + 301_000_000_000n }, /expired/],
    [message(accepted, { consensusTimestamp: "1790410301.000000000" }), context, /window/],
  ];
  for (const [signed, expected, error] of cases) {
    await assert.rejects(verifyDraft008ServiceResponse(testnet, signed, expected), error);
  }
  await withSellerMirror(async () => {
    await assert.rejects(verifyDraft008ServiceResponse(testnet, message(), context), /current seller key/);
  }, "02" + "00".repeat(32));
  const tampered = message();
  const envelope = JSON.parse(Buffer.from(tampered.bytes).toString());
  envelope.payload = Buffer.from(JSON.stringify({ ...accepted, action: "reject" })).toString("base64");
  await assert.rejects(verifyDraft008ServiceResponse(testnet,
    { ...tampered, bytes: Buffer.from(JSON.stringify(envelope)) }, context), /signature/);
});

test("deadline equality is live per the pinned Go state machine; one nanosecond later expires", async () => {
  const atDeadline = requestAt + 300_000_000_000n;
  const response = message(accepted, { consensusTimestamp: "1790410300.000000000" });
  await withSellerMirror(async () => {
    const verified = await verifyDraft008ServiceResponse(testnet, response,
      { ...context, nowNanoseconds: atDeadline });
    assert.equal(verified.response.action, "accept");
  });
  await assert.rejects(verifyDraft008ServiceResponse(testnet, response,
    { ...context, nowNanoseconds: atDeadline + 1n }), /expired/);
  await assert.rejects(verifyDraft008ServiceResponse(testnet, response,
    { ...context, network: "mainnet", nowNanoseconds: atDeadline }), /networks/);
});

test("strict base schema and canonical order reject malformed or extra financial claims", async () => {
  const bad = [
    { ...accepted, evidenceHash: "0x1234" },
    { ...accepted, buyerAddress: sellerAddress },
    { ...accepted, action: "counter" },
    { ...accepted, action: "counter", counterAmount: "10", counterInterval: null },
    { ...accepted, action: "counter", counterAmount: "01", counterInterval: "1" },
    { ...accepted, action: "counter", counterAmount: "0", counterInterval: "1" },
    { ...accepted, action: "counter", counterAmount: "10", counterInterval: "18446744073709551616" },
    { ...accepted, version: "2.0.0" },
    { ...accepted, version: "1.1.0", counterAmount: "1" },
    { ...accepted, requestId: "not-a-uuid" },
    { action: "accept", ...accepted },
  ];
  for (const payload of bad) {
    await assert.rejects(verifyDraft008ServiceResponse(testnet, message(payload), context));
  }
});

test("minor-version extensions can be ignored without allowing them to change the base decision", async () => {
  await withSellerMirror(async () => {
    const response = await verifyDraft008ServiceResponse(testnet, message({
      ...accepted, version: "1.1.0", extraFlag: true,
    }), context);
    assert.deepEqual(response.response, { ...accepted, version: "1.1.0" });
    await assert.rejects(verifyDraft008ServiceResponse(testnet,
      message({ ...accepted, version: "1.1.0", extraFlag: null }), context), /null/);
  });
});
