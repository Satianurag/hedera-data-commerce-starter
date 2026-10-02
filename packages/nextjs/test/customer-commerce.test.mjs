import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import Database from "better-sqlite3";
import { Wallet } from "ethers";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const escrowAddress = "0xD5165317aA5F8fDA9735d59956d839BEA0730D4A";

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startApp(directory, overrides = {}) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: appDirectory,
    env: { ...process.env, HEDERA_NETWORK: "testnet", NEURON_ENABLE_CUSTOMER_AUTH: "true",
      NEURON_ENABLE_CUSTOMER_COMMERCE_REVIEW: "true", NEURON_ENABLE_CUSTOMER_FUNDING: "true",
      NEURON_ENABLE_CUSTOMER_APPROVAL: "false", NEURON_APP_ORIGIN: origin,
      NEURON_CUSTOMER_DB_FILE: join(directory, "commerce.sqlite"),
      NEURON_COMMERCE_SELLER_ACCOUNT_ID: "0.0.7", NEURON_SELLER_ACCOUNT_ID: "0.0.7",
      NEURON_COMMERCE_QUOTE_TOPIC_ID: "0.0.10", NEURON_COMMERCE_SERVICE_ID: "1",
      HEDERA_CONTRACT_ID: "0.0.8", HEDERA_CONTRACT_ADDRESS: escrowAddress,
      NEURON_COMMERCE_MAX_SPEND_TINYBAR: "10000000", HEDERA_RPC_URL: "", ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output = (output + chunk).slice(-4096); });
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) throw new Error(`Next exited before ready: ${output}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return { child, origin };
    } catch { /* Wait for the loopback production server. */ }
    await delay(150);
  }
  child.kill("SIGTERM");
  throw new Error(`Next did not become ready: ${output}`);
}

async function stopApp(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 30 && child.exitCode === null; attempt++) await delay(100);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function signIn(origin) {
  const wallet = Wallet.createRandom();
  const challengeResponse = await fetch(origin + "/api/customer-auth/challenge", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address }),
  });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const response = await fetch(origin + "/api/customer-auth/verify", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId,
      signature: await wallet.signMessage(challenge.message) }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  return { cookie: response.headers.get("set-cookie").split(";")[0], session };
}

function post(origin, route, cookie, body, requestOrigin = origin) {
  return fetch(origin + route, { method: "POST",
    headers: { Origin: requestOrigin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body) });
}

test("new funding stays closed without approval while buyer recovery routes remain authenticated", async t => {
  const directory = mkdtempSync(join(tmpdir(), "neuron-commerce-gate-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await startApp(directory);
  try {
    const { cookie, session } = await signIn(app.origin);
    assert.equal((await fetch(app.origin + "/api/customer-funding")).status, 401);
    assert.equal((await fetch(app.origin + "/api/customer-refund")).status, 401);
    const funding = await fetch(app.origin + "/api/customer-funding", { headers: { Cookie: cookie } });
    assert.equal(funding.status, 200);
    assert.deepEqual(await funding.json(), { funding: null,
      history: { records: [], hasMore: false }, page: 0, fundingEnabled: false });
    const refund = await fetch(app.origin + "/api/customer-refund", { headers: { Cookie: cookie } });
    assert.equal(refund.status, 200);
    assert.deepEqual(await refund.json(), { refund: null });
    assert.equal((await post(app.origin, "/api/customer-funding", cookie,
      { action: "prepare", quoteIntentId: "a".repeat(32) })).status, 404);
    assert.equal((await post(app.origin, "/api/customer-funding", cookie,
      { action: "openWallet", fundingId: "b".repeat(32) })).status, 404);
    assert.equal((await post(app.origin, "/api/customer-funding", cookie,
      { action: "retryWallet", fundingId: "b".repeat(32) })).status, 400);
    assert.equal((await post(app.origin, "/api/customer-funding", cookie,
      { action: "retryWallet", fundingId: "b".repeat(32), acknowledged: true })).status, 404);
    assert.equal((await post(app.origin, "/api/customer-funding", cookie,
      { action: "retryWallet", fundingId: "b".repeat(32), acknowledged: true }, "http://wrong.example")).status, 403);
    assert.equal((await post(app.origin, "/api/customer-funding", cookie,
      { action: "resolveExpired", fundingId: "b".repeat(32) }, "http://wrong.example")).status, 403);

    // A journal row can outlive its original session. Missing original runtime
    // provenance must not be turned into an "abandoned" funding conclusion.
    const db = new Database(join(directory, "commerce.sqlite"));
    try {
      db.prepare(`INSERT INTO customer_funding_intents
        (id, quote_intent_id, session_id, owner_address, origin, state,
         contract_id, contract_address, seller_address, terms_hash, amount_tinybar,
         quote_expires_at, refund_after, prepared_block, scan_next_block,
         prepared_at, transaction_json, updated_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("b".repeat(32), "c".repeat(32), session.sessionId, session.ownerAddress, app.origin,
          "0.0.8", escrowAddress, Wallet.createRandom().address, `0x${"d".repeat(64)}`,
          "10000000", 1, 2, 1, 1, 1, "{}", 1);
      db.prepare(`INSERT INTO customer_refund_intents
        (id, funding_id, session_id, owner_address, origin, state, escrow_id,
         contract_id, contract_address, amount_tinybar, prepared_block,
         scan_next_block, prepared_at, transaction_json, wallet_opened_at,
         wallet_open_count, updated_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("e".repeat(32), "b".repeat(32), session.sessionId, session.ownerAddress,
          app.origin, "1", "0.0.8", escrowAddress, "10000000", 1, 1, 1,
          "{}", Math.floor(Date.now() / 1000), 1, 1);
    } finally { db.close(); }
    const owned = await fetch(app.origin + "/api/customer-funding", { headers: { Cookie: cookie } });
    assert.equal(owned.status, 200);
    const ownedBody = await owned.json();
    assert.equal(ownedBody.funding.id, "b".repeat(32));
    assert.equal(ownedBody.funding.state, "prepared");
    assert.equal(ownedBody.funding.abiPinned, false);
    assert.equal(ownedBody.reconciliation, "unavailable");
    assert.equal(ownedBody.history.records.length, 1);
    const unresolved = await post(app.origin, "/api/customer-funding", cookie,
      { action: "resolveExpired", fundingId: "b".repeat(32) });
    assert.equal(unresolved.status, 409);
    const refundHistory = await fetch(app.origin + "/api/customer-refund?fundingId=" + "b".repeat(32),
      { headers: { Cookie: cookie } });
    assert.equal(refundHistory.status, 200);
    assert.equal((await refundHistory.json()).refund.walletOpenCount, 1);
    const prematureRetry = await post(app.origin, "/api/customer-refund", cookie,
      { action: "retryWallet", refundId: "e".repeat(32) });
    assert.equal(prematureRetry.status, 400, "retry requires explicit acknowledgement");
    const acknowledgedRetry = await post(app.origin, "/api/customer-refund", cookie,
      { action: "retryWallet", refundId: "e".repeat(32), acknowledged: true });
    assert.equal(acknowledgedRetry.status, 409);
    const other = await signIn(app.origin);
    const hidden = await fetch(app.origin + "/api/customer-funding", { headers: { Cookie: other.cookie } });
    assert.equal(hidden.status, 200);
    assert.equal((await hidden.json()).history.records.length, 0);
    const hiddenRefund = await fetch(app.origin + "/api/customer-refund?fundingId=" + "b".repeat(32),
      { headers: { Cookie: other.cookie } });
    assert.equal(hiddenRefund.status, 200);
    assert.equal((await hiddenRefund.json()).refund, null);
  } finally { await stopApp(app.child); }
});

test("approval-enabled commerce rejects a service or seller incompatible with the live request", async t => {
  for (const overrides of [{ NEURON_COMMERCE_SERVICE_ID: "other" },
    { NEURON_COMMERCE_SELLER_ACCOUNT_ID: "0.0.9" }]) {
    const directory = mkdtempSync(join(tmpdir(), "neuron-commerce-compat-"));
    chmodSync(directory, 0o700);
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const app = await startApp(directory, { NEURON_ENABLE_CUSTOMER_APPROVAL: "true", ...overrides });
    try {
      const { cookie } = await signIn(app.origin);
      const response = await fetch(app.origin + "/api/customer-commerce", { headers: { Cookie: cookie } });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /legacy ADS-B service 1 and the same seller account/);
    } finally { await stopApp(app.child); }
  }
});
