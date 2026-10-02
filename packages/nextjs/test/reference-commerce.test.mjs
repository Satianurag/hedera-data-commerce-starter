import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { Interface, ZeroAddress } from "ethers";
import ts from "typescript";

const source = readFileSync(new URL("../lib/reference-types.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const context = { exports: {}, require: createRequire(import.meta.url) };
vm.runInNewContext(compiled, context);
const { parseReferenceConfig, parseReferenceSession, referenceWalletFailure, validateReferenceTransaction, referenceRevision } = context.exports;
const buyer = "0x1111111111111111111111111111111111111111";
const seller = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const escrow = "0x4444444444444444444444444444444444444444";
const config = { enabled: true, network: "testnet", chainId: 296, sourceRevision: referenceRevision,
  service: { name: "Owner file", filename: "README.md", bytes: 64, sha256: "a".repeat(64),
    priceBaseUnits: "1000", currency: `eip155:296/erc20:${token}`, tokenAddress: token, tokenDecimals: 6, tokenSymbol: "TEST", sellerAddress: seller },
  escrowAddress: escrow, limits: { refundAfterSeconds: 900 }, identityNote: "Delegated protocol signer" };
const session = { id: "23111072-6e9c-4a77-84ae-cb06cacbb963", buyerAddress: buyer,
  customerSessionId: "a".repeat(32), state: "agreed", message: "", createdAt: 1790000000,
  deadline: 1790000900, agreementHash: "0x" + "b".repeat(64), messages: [], transactions: [], walletActions: [] };
const abi = new Interface(["function createEscrow(address,address,address,address,uint64,bytes32,uint64)",
  "function approve(address,uint256)", "function deposit(uint256,uint256)"]);
const action = (kind, to, data) => ({ kind, label: kind, chainId: 296, to, data, value: "0x0" });

test("reference wallet calls bind recipient, buyer, token, amount, agreement and refund deadline", () => {
  const create = (overrides = []) => action("create", escrow, abi.encodeFunctionData("createEscrow",
    overrides.length ? overrides : [buyer, seller, ZeroAddress, token, 1, session.agreementHash, session.deadline]));
  assert.doesNotThrow(() => validateReferenceTransaction(create(), session, config));
  const original = [buyer, seller, ZeroAddress, token, 1, session.agreementHash, session.deadline];
  for (const [index, replacement] of [[0, seller], [1, buyer], [2, buyer], [3, seller], [4, 2],
    [5, "0x" + "c".repeat(64)], [6, session.deadline + 1]]) {
    const values = [...original]; values[index] = replacement;
    assert.throws(() => validateReferenceTransaction(create(values), session, config));
  }
  const approve = action("token-approve", token, abi.encodeFunctionData("approve", [escrow, "1000"]));
  assert.doesNotThrow(() => validateReferenceTransaction(approve, session, config));
  for (const invalid of [{ ...approve, to: seller }, { ...approve, chainId: 295 }, { ...approve, value: "0x1" },
    { ...approve, data: abi.encodeFunctionData("approve", [escrow, "1001"]) },
    { ...approve, data: abi.encodeFunctionData("approve", [seller, "1000"]) }]) {
    assert.throws(() => validateReferenceTransaction(invalid, session, config));
  }
  const deposit = action("deposit", escrow, abi.encodeFunctionData("deposit", [7, "1000"]));
  assert.doesNotThrow(() => validateReferenceTransaction(deposit, { ...session, escrowId: "7" }, config));
  assert.throws(() => validateReferenceTransaction(deposit, { ...session, escrowId: "8" }, config));
});

test("reference responses reject another buyer, changed source file, wrong network and unknown revision", () => {
  assert.equal(parseReferenceConfig(config).service.priceBaseUnits, "1000");
  assert.throws(() => parseReferenceConfig({ ...config, chainId: 295 }));
  assert.throws(() => parseReferenceConfig({ ...config, sourceRevision: "unknown" }));
  assert.throws(() => parseReferenceConfig({ ...config, service: { ...config.service, currency: `eip155:295/erc20:${token}` } }));
  assert.throws(() => parseReferenceConfig({ ...config, service: { ...config.service, currency: `eip155:296/erc20:${seller}` } }));
  assert.throws(() => parseReferenceSession(session, config, seller));
  const delivered = { ...session, delivery: { filename: "README.md", bytes: 64, sha256: "a".repeat(64) } };
  assert.equal(parseReferenceSession(delivered, config, buyer).delivery.downloadPath,
    `/api/reference/sessions/${session.id}/file`);
  assert.throws(() => parseReferenceSession({ ...delivered,
    delivery: { ...delivered.delivery, sha256: "c".repeat(64) } }, config, buyer));
});

test("unconfirmed HCS records remain visible without claiming a Mirror sequence", () => {
  const pending = { ...session, state: "uncertain", agreementHash: "", messages: [{ kind: "serviceRequest", topicId: "0.0.100",
    sequenceNumber: "0", transactionId: "0.0.100@1790000000.000000001", sha256: "a".repeat(64),
    mirrorVerified: false, senderAddress: seller, payload: { type: "serviceRequest" } }] };
  assert.equal(parseReferenceSession(pending, config, buyer).messages[0].mirrorVerified, false);
  assert.throws(() => parseReferenceSession({ ...pending,
    messages: [{ ...pending.messages[0], mirrorVerified: true }] }, config, buyer));
});

test("wallet nonce is preserved exactly and malformed nonce encodings are rejected", () => {
  const approve = action("token-approve", token, abi.encodeFunctionData("approve", [escrow, "1000"]));
  for (const nonce of ["0x0", "0x2", "0xffffffffffffffff"]) {
    const parsed = parseReferenceSession({ ...session, walletActions: [{ ...approve, nonce }] }, config, buyer);
    assert.equal(parsed.walletActions[0].nonce, nonce);
  }
  for (const nonce of [2, "2", "0x02", "0x-1", "0x10000000000000000", "0xg"]) {
    assert.throws(() => parseReferenceSession({ ...session, walletActions: [{ ...approve, nonce }] }, config, buyer));
  }
});

test("plain-object wallet errors expose only bounded message and numeric code", () => {
  assert.equal(referenceWalletFailure({ code: -32603, message: "Deposit gas estimate failed", data: { secret: "not displayed" } }),
    "Wallet error -32603: Deposit gas estimate failed");
  const text = referenceWalletFailure({ code: -32603, message: "failure\n" + "x".repeat(1000) });
  assert.ok(text.length < 350);
  assert.ok(!text.includes("\n"));
  assert.ok(referenceWalletFailure({ code: 4001 }).includes("earlier submitted transaction"));
});


test("surplus recovery exposes exact seller payment and independently verified refund amounts", () => {
  const paid = { ...session, state: "paid-with-remainder", paidAmountBaseUnits: "1000", remainingBalanceBaseUnits: "1" };
  assert.equal(parseReferenceSession(paid, config, buyer).remainingBalanceBaseUnits, "1");
  const refunded = { ...paid, state: "refunded-with-remainder", refundAmountBaseUnits: "1", remainingBalanceBaseUnits: "2" };
  assert.equal(parseReferenceSession(refunded, config, buyer).refundAmountBaseUnits, "1");
  for (const invalid of [{ ...paid, paidAmountBaseUnits: "1001" }, { ...paid, remainingBalanceBaseUnits: "0" },
    { ...paid, remainingBalanceBaseUnits: undefined },
    { ...refunded, refundAmountBaseUnits: "0" },
    { ...refunded, remainingBalanceBaseUnits: "-1" }, { ...refunded, remainingBalanceBaseUnits: (1n << 256n).toString() }]) {
    assert.throws(() => parseReferenceSession(invalid, config, buyer));
  }
  assert.doesNotThrow(() => parseReferenceSession({ ...session, state: "paid" }, config, buyer));
  for (const state of ["paid-with-remainder", "refunded-with-remainder"]) {
    const legacy = parseReferenceSession({ ...session, state, remainingBalanceBaseUnits: "1" }, config, buyer);
    assert.equal(legacy.paidAmountBaseUnits, undefined);
    assert.equal(legacy.refundAmountBaseUnits, undefined);
  }
  assert.doesNotThrow(() => parseReferenceSession({ ...session, state: "refunded", refundAmountBaseUnits: "1001", remainingBalanceBaseUnits: "0" }, config, buyer));
});

test("repeated approval and refund recovery retain bounded transaction history beyond 32 entries", () => {
  const transactions = Array.from({ length: 40 }, (_, i) => ({ kind: "token-approve", status: "confirmed",
    transactionHash: "0x" + i.toString(16).padStart(64, "0") }));
  assert.equal(parseReferenceSession({ ...session, transactions }, config, buyer).transactions.length, 40);
  assert.throws(() => parseReferenceSession({ ...session, transactions: Array(1025).fill(transactions[0]) }, config, buyer));
  assert.throws(() => parseReferenceSession({ ...session, transactions: [...transactions, { ...transactions[0], transactionHash: "invalid" }] }, config, buyer));
});
