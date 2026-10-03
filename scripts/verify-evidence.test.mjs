import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SigningKey, Signature, computeAddress, keccak256 } from "ethers";
import {
  abi,
  reconstructHistoricalHCS,
  verifyEnvelope,
  verifyReceipt,
  verifyEvidence,
  readPublicJSON,
} from "./verify-evidence.mjs";

const bytes = Buffer.from("a historical message split between two real HCS-sized chunks");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const expected = {
  topic: "0.0.7",
  sequence: 9,
  payer: "0.0.8",
  bytes: bytes.length,
  sha256: sha(bytes),
};
const id = {
  account_id: "0.0.8",
  transaction_valid_start: "100.000000001",
  nonce: 0,
  scheduled: false,
};
const rows = [0, 1].map((index) => ({
  topic_id: "0.0.7",
  sequence_number: index ? 9 : 7,
  payer_account_id: "0.0.8",
  message: bytes.subarray(index ? 20 : 0, index ? bytes.length : 20).toString("base64"),
  chunk_info: { initial_transaction_id: id, total: 2, number: index + 1 },
}));

test("exact historical HCS survives later messages and interleaving", () => {
  const unrelated = {
    ...rows[0],
    sequence_number: 8,
    chunk_info: {
      ...rows[0].chunk_info,
      initial_transaction_id: { ...id, transaction_valid_start: "101.000000001" },
    },
  };
  assert.deepEqual(
    reconstructHistoricalHCS(rows[1], [rows[1], unrelated, rows[0]], expected),
    bytes,
  );
  assert.throws(() =>
    reconstructHistoricalHCS({ ...rows[1], sequence_number: 10 }, rows, expected),
  );
});

test("missing, duplicate, wrong-payer, changed-byte and nonfinal HCS evidence fails", () => {
  for (const candidates of [
    [rows[1]],
    [rows[0], rows[0], rows[1]],
    [{ ...rows[0], payer_account_id: "0.0.99" }, rows[1]],
    [{ ...rows[0], message: Buffer.from("tampered").toString("base64") }, rows[1]],
  ]) {
    assert.throws(() => reconstructHistoricalHCS(rows[1], candidates, expected));
  }
  assert.throws(
    () => reconstructHistoricalHCS(rows[0], rows, { ...expected, sequence: 7 }),
    /final chunk/,
  );
  assert.throws(() =>
    reconstructHistoricalHCS(rows[1], [rows[0], { ...rows[1], topic_id: "0.0.99" }], expected),
  );
});

test("signature has independent timestamp/sequence preimage and current payer key binding", () => {
  // Public deterministic test-only key, never an account credential.
  const signer = new SigningKey("0x" + "11".repeat(32));
  const payload = Buffer.from('{"service":"test"}');
  const preimage = Buffer.alloc(16 + payload.length);
  preimage.writeBigUInt64BE(12n);
  preimage.writeBigUInt64BE(3n, 8);
  payload.copy(preimage, 16);
  const sig = Signature.from(signer.sign(keccak256(preimage)));
  const signature = Buffer.concat([
    Buffer.from(sig.r.slice(2), "hex"),
    Buffer.from(sig.s.slice(2), "hex"),
    Buffer.from([sig.yParity]),
  ]);
  const envelope = {
    timestamp: "12",
    sequenceNumber: "3",
    payload: payload.toString("base64"),
    signature: signature.toString("base64"),
    senderAddress: computeAddress(signer.publicKey),
  };
  const account = { key: { _type: "ECDSA_SECP256K1", key: signer.compressedPublicKey.slice(2) } };
  assert.equal(
    verifyEnvelope(Buffer.from(JSON.stringify(envelope)), envelope.senderAddress, account, true)
      .currentPayerKeyMatches,
    true,
  );
  assert.throws(() =>
    verifyEnvelope(
      Buffer.from(JSON.stringify({ ...envelope, timestamp: "13" })),
      envelope.senderAddress,
      account,
      true,
    ),
  );
  assert.throws(
    () => verifyEnvelope(Buffer.from(JSON.stringify(envelope)), envelope.senderAddress, {}, true),
    /payer key/,
  );
  assert.equal(
    verifyEnvelope(Buffer.from(JSON.stringify(envelope)), envelope.senderAddress, {}, false)
      .currentPayerKeyMatches,
    false,
  );
});

test("HTTP success cannot masquerade as successful payment, nor wrong payout amount/recipient", () => {
  const hash = "0x" + "ab".repeat(32);
  const recipient = "0x" + "12".repeat(20);
  const contract = "0x" + "34".repeat(20);
  const event = abi.encodeEventLog(abi.getEvent("Released"), [1, recipient, recipient, 100000]);
  const claim = {
    hash,
    contractId: "0.0.100",
    result: "SUCCESS",
    amountTinybar: "0",
    events: [
      {
        event: "Released",
        address: contract,
        args: { id: "1", seller: recipient, to: recipient, amount: "100000" },
      },
    ],
    nativeTransfers: [{ from: "0.0.100", to: "0.0.101", tinybar: "100000" }],
  };
  const receipt = {
    hash,
    contract_id: "0.0.100",
    result: "SUCCESS",
    amount: 0,
    logs: [{ ...event, address: contract }],
  };
  const actions = [{ caller: "0.0.100", recipient: "0.0.101", value: 100000 }];
  assert.equal(verifyReceipt(receipt, claim, actions).expectedFailure, false);
  assert.throws(() =>
    verifyReceipt({ ...receipt, result: "CONTRACT_REVERT_EXECUTED" }, claim, actions),
  );
  assert.throws(() => verifyReceipt({ ...receipt, hash: "0x" + "cd".repeat(32) }, claim, actions));
  for (const action of [
    { ...actions[0], value: 100001 },
    { ...actions[0], recipient: "0.0.102" },
  ])
    assert.throws(() => verifyReceipt(receipt, claim, [action]));
  const failedClaim = { ...claim, result: "INSUFFICIENT_GAS", events: [], nativeTransfers: [] };
  assert.equal(
    verifyReceipt({ ...receipt, result: "INSUFFICIENT_GAS", logs: [] }, failedClaim)
      .expectedFailure,
    true,
  );
  assert.throws(() => verifyReceipt(receipt, failedClaim));
});

test("verification reports provider errors as failures, never accepted live-flow success", async () => {
  const manifest = {
    schema: "test",
    network: "testnet",
    chainId: "0x128",
    hcs: [],
    receipts: [],
    runtime: {},
    escrows: {},
    token: {},
  };
  const result = await verifyEvidence({
    manifest,
    read: async () => {
      throw Error("provider unavailable");
    },
  });
  assert.equal(result.passed, false);
  assert(result.checks.every((row) => !row.passed));
  await assert.rejects(readPublicJSON("https://attacker.invalid/"), /Unapproved/);
});
