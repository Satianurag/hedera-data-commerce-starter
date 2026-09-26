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
const fundingId = "b".repeat(32);
const approvalId = "a".repeat(32);
const approvalHash = `0x${"c".repeat(64)}`;

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startApp(network, directory, port) {
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: appDirectory,
    env: { ...process.env, HEDERA_NETWORK: network, NEURON_ENABLE_CUSTOMER_AUTH: "true",
      NEURON_ENABLE_CUSTOMER_FUNDING: "true", NEURON_ENABLE_CUSTOMER_APPROVAL: "true",
      NEURON_ENABLE_CUSTOMER_COMMERCE_REVIEW: "false", NEURON_APP_ORIGIN: origin,
      NEURON_CUSTOMER_DB_FILE: join(directory, "approval.sqlite") },
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
    } catch { /* Wait for the local production server. */ }
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

function post(origin, path, body, headers = {}) {
  return fetch(origin + path, { method: "POST", headers: { Origin: origin,
    "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function signIn(origin, wallet) {
  const challengeResponse = await post(origin, "/api/customer-auth/challenge", { address: wallet.address });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const response = await post(origin, "/api/customer-auth/verify", {
    challengeId: challenge.challengeId, signature: await wallet.signMessage(challenge.message),
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get("set-cookie").split(";")[0], session: await response.json() };
}

test("buyer approval guards, durable uncertain wallet state and owner reauthentication", async t => {
  const directory = mkdtempSync(join(tmpdir(), "neuron-approval-test-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const port = await freePort();
  let app = await startApp("testnet", directory, port);
  try {
    const wallet = Wallet.createRandom();
    const otherWallet = Wallet.createRandom();
    const approvalPath = `/api/customer-approval?fundingId=${fundingId}`;
    assert.equal((await fetch(app.origin + approvalPath)).status, 401);
    assert.equal((await post(app.origin, "/api/customer-approval", { action: "prepare", fundingId })).status, 401);
    const { cookie, session } = await signIn(app.origin, wallet);
    assert.equal((await post(app.origin, "/api/customer-approval", { action: "prepare", fundingId },
      { Cookie: cookie, Origin: "http://wrong.example" })).status, 403);
    assert.equal((await fetch(app.origin + "/api/customer-approval?fundingId=bad",
      { headers: { Cookie: cookie } })).status, 400);
    assert.equal((await fetch(app.origin + approvalPath + "&extra=1",
      { headers: { Cookie: cookie } })).status, 400);
    const initial = await fetch(app.origin + approvalPath, { headers: { Cookie: cookie } });
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), { approval: null, approvalEnabled: true });
    assert.equal((await post(app.origin, "/api/customer-approval",
      { action: "wallet-opened", approvalId }, { Cookie: cookie })).status, 400);
    assert.equal((await post(app.origin, "/api/customer-approval",
      { action: "wallet-opened", approvalId, acknowledged: false }, { Cookie: cookie })).status, 400);
    assert.equal((await post(app.origin, "/api/customer-approval",
      { action: "prepare", fundingId }, { Cookie: cookie })).status, 404);

    // Synthetic journal row models a crash after the wallet was opened. No RPC,
    // seller data, wallet or contract transaction is fabricated by the app.
    const db = new Database(join(directory, "approval.sqlite"));
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO customer_approval_intents
      (id,funding_id,session_id,owner_address,origin,state,escrow_id,contract_id,contract_address,
       prepared_block,scan_next_block,prepared_at,transaction_json,request_topic,request_sequence,
       transport_bytes,transport_opened_at,transport_closed_at,updated_at)
      VALUES (?,?,?,?,?,'prepared',?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(approvalId, fundingId,
      session.sessionId, wallet.address, app.origin, "1", "0.0.1",
      "0x0000000000000000000000000000000000000001", 1, 1, now,
      JSON.stringify({ from: wallet.address, to: "0x0000000000000000000000000000000000000001",
        value: "0x0", data: "0x", gas: "0x1", gasPrice: "0x1", chainId: "0x128" }),
      "0.0.2", 1, 1, new Date(now * 1000 - 2000).toISOString(),
      new Date(now * 1000 - 1000).toISOString(), now);
    db.close();

    const reauth = await signIn(app.origin, wallet);
    assert.notEqual(reauth.session.sessionId, session.sessionId);
    const other = await signIn(app.origin, otherWallet);
    assert.equal((await (await fetch(app.origin + approvalPath,
      { headers: { Cookie: other.cookie } })).json()).approval, null);
    const original = await (await fetch(app.origin + approvalPath,
      { headers: { Cookie: reauth.cookie } })).json();
    assert.equal(original.approval.id, approvalId);
    assert.equal(original.approval.state, "prepared");
    assert.equal(original.reconciliation, "unavailable");
    assert.equal((await post(app.origin, "/api/customer-approval",
      { action: "wallet-opened", approvalId, acknowledged: true },
      { Cookie: other.cookie })).status, 404);

    const changed = new Database(join(directory, "approval.sqlite"));
    changed.prepare(`UPDATE customer_approval_intents SET state = 'wallet-opened',
      buyer_acknowledged_at = ?, updated_at = ? WHERE id = ?`).run(now, now, approvalId);
    changed.close();
    await stopApp(app.child);
    app = await startApp("testnet", directory, port);
    const afterRestart = await (await fetch(app.origin + approvalPath,
      { headers: { Cookie: reauth.cookie } })).json();
    assert.equal(afterRestart.approval.state, "wallet-opened");
    assert.equal(afterRestart.approval.acknowledgedAt, now);
    assert.equal((await post(app.origin, "/api/customer-approval",
      { action: "wallet-opened", approvalId, acknowledged: true },
      { Cookie: reauth.cookie })).status, 409);
    assert.equal((await post(app.origin, "/api/customer-approval",
      { action: "attach", approvalId, transactionHash: "bad" },
      { Cookie: reauth.cookie })).status, 400);
    const attached = await post(app.origin, "/api/customer-approval",
      { action: "attach", approvalId, transactionHash: approvalHash },
      { Cookie: reauth.cookie });
    assert.equal(attached.status, 200);
    assert.equal((await attached.json()).approval.state, "submitted");
    assert.equal((await post(app.origin, "/api/customer-approval",
      { action: "attach", approvalId, transactionHash: `0x${"d".repeat(64)}` },
      { Cookie: reauth.cookie })).status, 409);
  } finally {
    await stopApp(app.child);
  }

  app = await startApp("mainnet", directory, port);
  try {
    assert.equal((await fetch(app.origin + `/api/customer-approval?fundingId=${fundingId}`)).status, 404);
    assert.equal((await post(app.origin, "/api/customer-approval",
      { action: "prepare", fundingId })).status, 404);
  } finally {
    await stopApp(app.child);
  }
});
