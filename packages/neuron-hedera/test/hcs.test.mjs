import assert from "node:assert/strict";
import test from "node:test";
import { latestTopicMessageFromRows } from "../dist/hcs.js";

const topicId = "0.0.100";
const payer = "0.0.200";
const initialTransactionId = {
  account_id: payer,
  transaction_valid_start: "1790350000.000000001",
  nonce: 0,
  scheduled: false,
};

function row(sequence, message, chunkInfo) {
  return {
    topic_id: topicId,
    payer_account_id: payer,
    consensus_timestamp: `1790350001.${String(sequence).padStart(9, "0")}`,
    sequence_number: sequence,
    message: Buffer.from(message).toString("base64"),
    ...(chunkInfo === undefined ? {} : { chunk_info: chunkInfo }),
  };
}

test("missing and null chunk metadata are independent single messages", () => {
  for (const value of [undefined, null]) {
    const latest = latestTopicMessageFromRows([row(1, "A", value)], topicId);
    assert.equal(Buffer.from(latest.bytes).toString(), "A");
    assert.equal(latest.initialTransactionId, null);
  }
});

test("the HCS byte limit applies to each chunk, not to the reassembled message", () => {
  const fullChunk = Buffer.alloc(1024, 0);
  const extraByte = Buffer.from([255]);
  const first = row(20, fullChunk, { initial_transaction_id: initialTransactionId, number: 1, total: 2 });
  const second = row(21, extraByte, { initial_transaction_id: initialTransactionId, number: 2, total: 2 });
  const latest = latestTopicMessageFromRows([second, first], topicId);
  assert.deepEqual(Buffer.from(latest.bytes), Buffer.concat([fullChunk, extraByte]));
  assert.throws(() => latestTopicMessageFromRows([row(22, Buffer.alloc(1025), null)], topicId), /size/);
});

test("malformed base64 is rejected before it can be presented as evidence", () => {
  assert.throws(() => latestTopicMessageFromRows([{ ...row(23, "A", null), message: "QQ=" }], topicId), /encoding/);
});

test("interleaved topic sequences do not break transaction chunk order", () => {
  const second = row(12, "B", { initial_transaction_id: initialTransactionId, number: 2, total: 2 });
  const unrelated = row(11, "X", {
    initial_transaction_id: { ...initialTransactionId, transaction_valid_start: "1790350000.000000002" },
    number: 1,
    total: 21,
  });
  const first = row(10, "A", { initial_transaction_id: initialTransactionId, number: 1, total: 2 });
  const latest = latestTopicMessageFromRows([second, unrelated, first], topicId);
  assert.equal(Buffer.from(latest.bytes).toString(), "AB");
  assert.equal(latest.sequenceNumber, 12);
  assert.deepEqual(latest.initialTransactionId, initialTransactionId);
});

test("incomplete, duplicate and malformed chunks are not accepted", () => {
  const second = row(12, "B", { initial_transaction_id: initialTransactionId, number: 2, total: 2 });
  assert.equal(latestTopicMessageFromRows([second], topicId), null);
  assert.throws(() => latestTopicMessageFromRows([second, second], topicId), /duplicate/);
  assert.throws(() => latestTopicMessageFromRows([
    row(13, "A", { initial_transaction_id: initialTransactionId, number: 3, total: 2 }),
  ], topicId), /Malformed Mirror chunk/);
  assert.throws(() => latestTopicMessageFromRows([row(14, "A", 0)], topicId), /Malformed Mirror chunk/);
});
