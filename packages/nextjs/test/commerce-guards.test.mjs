import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import Database from "better-sqlite3";
import ts from "typescript";
const source = readFileSync(new URL("../lib/commerce-guards.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const context = { exports: {} }; vm.runInNewContext(compiled, context);
const { currentCommerceSession, assertRefundReceiptHashes } = context.exports;

test("financial commit rejects a revoked, expired or differently owned durable session", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE customer_sessions (session_id TEXT, owner_address TEXT, origin TEXT, revoked_at INTEGER, expires_at INTEGER)");
    const session = { sessionId: "session", ownerAddress: "buyer", expiresAt: 200 };
    const origin = new URL("https://example.com");
    const live = () => currentCommerceSession(db, session, origin, 100);
    assert.equal(live(), false);
    db.prepare("INSERT INTO customer_sessions VALUES (?, ?, ?, NULL, ?)").run("session", "buyer", origin.origin, 200);
    assert.equal(live(), true);
    db.exec("UPDATE customer_sessions SET revoked_at = 99"); assert.equal(live(), false);
    db.exec("UPDATE customer_sessions SET revoked_at = NULL, expires_at = 100"); assert.equal(live(), false);
    db.exec("UPDATE customer_sessions SET expires_at = 200, owner_address = 'other'"); assert.equal(live(), false);
    db.exec("UPDATE customer_sessions SET owner_address = 'buyer'");
    assert.equal(currentCommerceSession(db, session, new URL("https://other.example"), 100), false);
    assert.equal(currentCommerceSession(db, { ...session, expiresAt: 100 }, origin, 100), false);
  } finally { db.close(); }
});
test("refund evidence binds both receipt and Mirror to the selected hash", () => {
  const hash = "0x" + "a".repeat(64); const other = "0x" + "b".repeat(64);
  assert.doesNotThrow(() => assertRefundReceiptHashes(hash, hash, hash));
  for (const pair of [[other, hash], [hash, other], [null, hash], [hash, undefined]]) {
    assert.throws(() => assertRefundReceiptHashes(hash, ...pair), /hash mismatch/);
  }
});
