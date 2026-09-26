import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Compile this dependency-free TypeScript selector in memory so the same source
// is exercised under both supported Node runtimes without a test-only loader.
const source = readFileSync(fileURLToPath(new URL("../lib/customer-approval-evidence.ts", import.meta.url)), "utf8");
const javascript = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText;
const { selectCompletedTransport } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

test("completed gateway bytes bind seller key, purchase session and quoted duration", () => {
  const now = Date.now();
  const openedAt = new Date(now - 30_000).toISOString();
  const closedAt = new Date(now - 10_000).toISOString();
  const buyer = "0x1234567890123456789012345678901234567890";
  const purchaseSession = "a".repeat(32);
  const seller = "0.0.4318411";
  const sellerKey = `02${"1".repeat(64)}`;
  const interval = { openedAt, closedAt, writtenBytes: 512 };
  const evidence = { network: "testnet", sellerAccount: seller, sellerPublicKey: sellerKey,
    ownerAddress: buyer.toLowerCase(), customerSessionId: purchaseSession,
    transportEvidenceOnly: true, closedConnections: 1, interruptedConnections: 0,
    openConnections: 0, totalWrittenBytes: 512, truncated: false, connections: [interval] };
  const select = (record, afterMs = now - 31_000, minimumDurationMs = 20_000,
    preferred) => selectCompletedTransport(record, buyer, purchaseSession, seller,
    sellerKey, afterMs, now + 60_000, minimumDurationMs, preferred);

  assert.deepEqual(select(evidence), { bytes: 512, openedAt, closedAt });
  assert.equal(select(evidence, now - 29_000), null, "bytes before the HCS request cannot qualify");
  assert.equal(select(evidence, now - 31_000, 21_000), null, "short transport cannot satisfy a longer quote");
  assert.equal(select(evidence, now - 31_000, 20_000,
    { bytes: 513, openedAt, closedAt }), null, "wallet open must use the original completed interval");
  assert.equal(select({ ...evidence, connections: [{ ...interval, writtenBytes: 0 }],
    totalWrittenBytes: 0 }), null);
  assert.equal(select({ ...evidence, closedConnections: 0, interruptedConnections: 1,
    connections: [], totalWrittenBytes: 0 }), null,
  "interrupted connections have no known positive byte count");
  assert.throws(() => select({ ...evidence, sellerPublicKey: `03${"1".repeat(64)}` }), /mismatched/);
  assert.throws(() => select({ ...evidence, customerSessionId: "b".repeat(32) }), /mismatched/);
  assert.throws(() => select({ ...evidence, truncated: true }), /mismatched/);
  assert.throws(() => select({ ...evidence, totalWrittenBytes: Number.MAX_SAFE_INTEGER + 1 }), /mismatched/);
  assert.throws(() => select({ ...evidence, connections: [{ ...interval,
    writtenBytes: Number.MAX_SAFE_INTEGER + 1 }] }), /malformed/);
  assert.throws(() => select({ ...evidence, totalWrittenBytes: 513 }), /byte total/);
});
