import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, SigningKey, keccak256 } from "ethers";
import { inspectSignedTopicEnvelope } from "../dist/index.js";
import {
  createNativeSellerQuote,
  parseUniqueJSON,
  readPrivateFile,
} from "../scripts/native-quote.mjs";

function inputs() {
  const seller = Wallet.createRandom(),
    buyer = Wallet.createRandom();
  return {
    privateKey: seller.privateKey,
    amountTinybar: "100000",
    durationSeconds: 5,
    quoteLifetimeSeconds: 300,
    refundDelaySeconds: 600,
    nowSeconds: 1_800_000_000,
    profile: {
      accountId: "0.0.123",
      publicKey: SigningKey.computePublicKey(seller.privateKey, true).slice(2),
      quoteTopicId: "0.0.456",
      serviceId: "1",
    },
    descriptor: {
      network: "testnet",
      chainId: 296,
      sellerAccount: "0.0.123",
      quoteTopic: "0.0.456",
      serviceId: "1",
      escrowContractId: "0.0.789",
      escrowAddress: Wallet.createRandom().address,
      buyerAddress: buyer.address,
      sessionId: "abcd".repeat(8),
      sessionExpiresAt: 1_800_001_000,
      maxSpendTinybar: "1000000",
    },
  };
}

test("prepared native quote preserves canonical terms and actual seller signature without claiming consensus", () => {
  const input = inputs(),
    result = createNativeSellerQuote(input);
  const signed = inspectSignedTopicEnvelope(Buffer.from(result.envelope));
  assert.equal(signed.compressedPublicKey, input.profile.publicKey);
  assert.equal(keccak256(signed.payload), result.termsHash);
  assert.deepEqual(JSON.parse(Buffer.from(signed.payload)), result.terms);
  assert.equal(result.terms.amountTinybar, input.amountTinybar);
  assert.equal(result.terms.sessionId, input.descriptor.sessionId);
  assert.notEqual(createNativeSellerQuote(input).terms.nonce, result.terms.nonce);
});

test("wrong seller, network, customer, service, caps and stale sessions cannot produce terms", () => {
  const input = inputs();
  for (const patch of [
    { network: "mainnet" },
    { chainId: 295 },
    { sellerAccount: "0.0.999" },
    { quoteTopic: "0.0.999" },
    { serviceId: "2" },
    { sessionExpiresAt: input.nowSeconds + 100 },
    { buyerAddress: new Wallet(input.privateKey).address },
    { maxSpendTinybar: "1" },
  ]) {
    assert.throws(() =>
      createNativeSellerQuote({ ...input, descriptor: { ...input.descriptor, ...patch } }),
    );
  }
  for (const patch of [
    { privateKey: Wallet.createRandom().privateKey },
    { amountTinybar: "01" },
    { amountTinybar: "100000001" },
    { durationSeconds: 0 },
    { durationSeconds: 121 },
    { quoteLifetimeSeconds: 30 },
    { quoteLifetimeSeconds: 120 },
    { quoteLifetimeSeconds: 299 },
    { quoteLifetimeSeconds: 3601 },
    { refundDelaySeconds: 301 },
    { refundDelaySeconds: 484 },
  ]) {
    assert.throws(() => createNativeSellerQuote({ ...input, ...patch }));
  }
  assert.doesNotThrow(() => createNativeSellerQuote({ ...input, refundDelaySeconds: 485 }));
});

test("private quote inputs reject symlinks and group-readable credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-quote-"));
  chmodSync(dir, 0o700);
  try {
    const file = join(dir, "key"),
      link = join(dir, "link");
    writeFileSync(file, "disposable", { mode: 0o600 });
    assert.equal(readPrivateFile(file), "disposable");
    symlinkSync(file, link);
    assert.throws(() => readPrivateFile(link));
    chmodSync(file, 0o640);
    assert.throws(() => readPrivateFile(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ambiguous duplicate and escaped duplicate configuration fields are rejected", () => {
  assert.throws(() => parseUniqueJSON('{"amount":"1","amount":"2"}'), /Duplicate/);
  assert.throws(() => parseUniqueJSON('{"seller":{"id":"1","i\\u0064":"2"}}'), /Duplicate/);
  assert.deepEqual(parseUniqueJSON('{"nested":[{"one":"a\\\"b"},{"one":2}],"flag":true}'), {
    nested: [{ one: 'a"b' }, { one: 2 }],
    flag: true,
  });
});
