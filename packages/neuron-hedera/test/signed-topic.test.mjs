import assert from "node:assert/strict";
import test from "node:test";
import { inspectSignedTopicEnvelope } from "../dist/signed-topic.js";

// neuron-specs@13ab01d, impl/typescript/tests/conformance/vectors.ts, CHAIN2.
const vector = {
  senderAddress: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  signature: "KeAcbmf6DrifWKYyiCCEqYhSHbWtcdaX/BmkOTUMBrhG+/3xAV1ZfilJdPgkfBJsqzZjQsIRmUfKFCL1EGkWFwA=",
  timestamp: "1700000000000000000",
  sequenceNumber: "1",
  payload: "SGVsbG8=",
};

function inspect(value) {
  return inspectSignedTopicEnvelope(Buffer.from(JSON.stringify(value)));
}

test("upstream Chain 2 signed topic vector verifies without an SDK dependency", () => {
  const result = inspect(vector);
  assert.equal(result.senderAddress, vector.senderAddress);
  assert.equal(result.timestamp, 1700000000000000000n);
  assert.equal(result.sequenceNumber, 1n);
  assert.equal(Buffer.from(result.payload).toString(), "Hello");
  assert.equal(result.compressedPublicKey, "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
});

test("tampering, sender mismatch and Ethereum V encoding are rejected", () => {
  assert.throws(() => inspect({ ...vector, payload: "SGVsbG8h" }), /sender does not match/);
  assert.throws(() => inspect({ ...vector, senderAddress: "0x13E42Bbd9fD9bB9e46914423BDdbdA9f7C44aC79" }), /sender does not match/);
  const signature = Buffer.from(vector.signature, "base64");
  signature[64] = 27;
  assert.throws(() => inspect({ ...vector, signature: signature.toString("base64") }), /V 0 or 1/);
  const highS = Buffer.from(vector.signature, "base64");
  const curveOrder = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
  const lowS = BigInt(`0x${highS.subarray(32, 64).toString("hex")}`);
  Buffer.from((curveOrder - lowS).toString(16).padStart(64, "0"), "hex").copy(highS, 32);
  highS[64] ^= 1;
  assert.throws(() => inspect({ ...vector, signature: highS.toString("base64") }), /non-canonical s/);
});

test("canonical JSON, uint64 and base64 rules fail closed", () => {
  assert.throws(() => inspect({ ...vector, timestamp: "01700000000000000000" }), /canonical uint64/);
  assert.throws(() => inspect({ ...vector, timestamp: "18446744073709551616" }), /exceeds uint64/);
  assert.throws(() => inspect({ ...vector, payload: "SGVsbG8" }), /canonical base64/);
  const reordered = { signature: vector.signature, senderAddress: vector.senderAddress, timestamp: vector.timestamp,
    sequenceNumber: vector.sequenceNumber, payload: vector.payload };
  assert.throws(() => inspect(reordered), /canonical JSON/);
  assert.equal(inspect({ type: "legacy-heartbeat" }), null);
  assert.equal(inspectSignedTopicEnvelope(Buffer.from([0xff, 0x00])), null);
});
