import assert from "node:assert/strict";
import test from "node:test";
import { SigningKey, Signature, computeAddress, keccak256 } from "ethers";
import { networkConfigFromEnv } from "../dist/network.js";
import { confirmEscrowFunding, verifySignedSellerQuote } from "../dist/commerce.js";

const signingKey = new SigningKey(`0x${"01".padStart(64, "0")}`);
const sellerAddress = computeAddress(signingKey.publicKey);
const buyerAddress = "0x13E42Bbd9fD9bB9e46914423BDdbdA9f7C44aC79";
const escrowAddress = "0xD5165317aA5F8fDA9735d59956d839BEA0730D4A";
const now = 1_790_410_000n;
const testnet = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });

const quote = {
  type: "neuronCustomerQuote", version: "1", network: "testnet", chainId: "296",
  sellerAccountId: "0.0.7", sellerAddress, buyerAddress, serviceId: "adsb-v0.1",
  sessionId: "session-7", asset: "HBAR", amountTinybar: "10000000", maxAmountTinybar: "10000000",
  durationSeconds: "3600", issuedAt: String(now - 10n), expiresAt: String(now + 300n),
  refundAfter: String(now + 7200n), escrowContractId: "0.0.8", escrowAddress,
  nonce: "ab".repeat(32),
};
const expected = {
  sellerAccountId: "0.0.7", sellerTopicId: "0.0.10", buyerAddress, serviceId: "adsb-v0.1",
  sessionId: "session-7", escrowContractId: "0.0.8", escrowAddress,
  maxSpendTinybar: 10_000_000n, nowSeconds: now,
};

function signedMessage(terms = quote, overrides = {}) {
  const payload = Buffer.from(JSON.stringify(terms));
  const timestamp = String(now * 1_000_000_000n);
  const preimage = Buffer.alloc(16 + payload.length);
  preimage.writeBigUInt64BE(BigInt(timestamp), 0);
  preimage.writeBigUInt64BE(1n, 8);
  payload.copy(preimage, 16);
  const signature = signingKey.sign(keccak256(preimage));
  const raw = Buffer.concat([
    Buffer.from(signature.r.slice(2), "hex"), Buffer.from(signature.s.slice(2), "hex"),
    Buffer.from([Signature.from(signature).yParity]),
  ]);
  return { topicId: "0.0.10", payerAccountId: "0.0.7", sequenceNumber: 1,
    consensusTimestamp: `${now}.123456789`, initialTransactionId: null,
    bytes: Buffer.from(JSON.stringify({ senderAddress: sellerAddress, signature: raw.toString("base64"),
      timestamp, sequenceNumber: "1", payload: payload.toString("base64") })), ...overrides };
}

function withMirrorAccount(key, run, evmAddress = sellerAddress) {
  const previous = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(new URL(url).host, "testnet.mirrornode.hedera.com");
    assert.equal(new URL(url).pathname, "/api/v1/accounts/0.0.7");
    return Response.json({ account: "0.0.7", deleted: false, evm_address: evmAddress,
      key: { _type: "ECDSA_SECP256K1", key } });
  };
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = previous; });
}

test("seller-signed quote binds current Mirror key, buyer, cap, units and exact funding terms", async () => {
  await withMirrorAccount(signingKey.compressedPublicKey.slice(2), async () => {
    const result = await verifySignedSellerQuote(testnet, signedMessage(), expected);
    assert.equal(result.termsHash, keccak256(Buffer.from(JSON.stringify(quote))));
    assert.throws(() => confirmEscrowFunding(result, buyerAddress, "0x" + "00".repeat(32)), /explicitly confirm/);
    assert.throws(() => confirmEscrowFunding(result, sellerAddress, result.termsHash), /explicitly confirm/);
    assert.deepEqual(confirmEscrowFunding(result, buyerAddress, result.termsHash), {
      seller: sellerAddress, refundAfter: now + 7200n, termsHash: result.termsHash,
      valueWei: 100_000_000_000_000_000n,
    });
  });
});

test("lowercase Mirror EVM address normalizes without relaxing signed quote checksums", async () => {
  await withMirrorAccount(signingKey.compressedPublicKey.slice(2), async () => {
    const result = await verifySignedSellerQuote(testnet, signedMessage(), expected);
    assert.equal(result.terms.sellerAddress, sellerAddress);
  }, sellerAddress.toLowerCase());
  await withMirrorAccount(signingKey.compressedPublicKey.slice(2), async () => {
    await assert.rejects(verifySignedSellerQuote(testnet,
      signedMessage({ ...quote, sellerAddress: sellerAddress.toLowerCase() }), expected), /EIP-55/);
  }, sellerAddress.toLowerCase());
});

test("seller key rotation or forged payer stops terms before funding", async () => {
  await withMirrorAccount("02" + "00".repeat(32), async () => {
    await assert.rejects(verifySignedSellerQuote(testnet, signedMessage(), expected), /key or address/);
  });
  await assert.rejects(verifySignedSellerQuote(testnet, signedMessage(quote, { payerAccountId: "0.0.11" }), expected), /payer/);
  await withMirrorAccount(signingKey.compressedPublicKey.slice(2), async () => {
    await assert.rejects(verifySignedSellerQuote(testnet, signedMessage(), expected), /key or address/);
  }, buyerAddress);
});

test("money, network, expiry, service and contract mismatches fail closed", async () => {
  const cases = [
    [{ amountTinybar: "10000001" }, expected],
    [{ maxAmountTinybar: "10000001" }, expected],
    [{ amountTinybar: "0" }, expected],
    [{ amountTinybar: "0.1" }, expected],
    [{ asset: "USDC" }, expected],
    [{ network: "mainnet" }, expected],
    [{ chainId: "295" }, expected],
    [{ expiresAt: String(now - 1n) }, expected],
    [{ refundAfter: String(now - 1n) }, expected],
    [{ refundAfter: String(now + 3600n) }, expected],
    [{ nonce: "bad" }, expected],
    [{ sessionId: "other-session" }, expected],
    [{ escrowContractId: "0.0.19" }, expected],
    [{}, { ...expected, maxSpendTinybar: 9_999_999n }],
  ];
  await withMirrorAccount(signingKey.compressedPublicKey.slice(2), async () => {
    for (const [changes, expectation] of cases) {
      await assert.rejects(verifySignedSellerQuote(testnet, signedMessage({ ...quote, ...changes }), expectation));
    }
  });
  await assert.rejects(verifySignedSellerQuote(networkConfigFromEnv({ HEDERA_NETWORK: "mainnet" }), signedMessage(), expected), /testnet-only/);
  await assert.rejects(verifySignedSellerQuote(testnet, signedMessage(quote, { consensusTimestamp: `${now + 400n}.123456789` }), expected), /consensus time/);
});

test("quote payload rejects extra or reordered fields", async () => {
  await withMirrorAccount(signingKey.compressedPublicKey.slice(2), async () => {
    await assert.rejects(verifySignedSellerQuote(testnet, signedMessage({ ...quote, fee: "1" }), expected), /canonical/);
    await assert.rejects(verifySignedSellerQuote(testnet,
      signedMessage({ ...quote, evidenceTopicId: "0.0.9" }), expected), /canonical/);
    const { type, ...rest } = quote;
    await assert.rejects(verifySignedSellerQuote(testnet, signedMessage({ ...rest, type }), expected), /canonical/);
  });
});
