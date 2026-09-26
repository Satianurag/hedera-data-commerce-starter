import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, chmodSync, statSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Wallet } from "ethers";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const appDirectory = fileURLToPath(new URL("..", import.meta.url));

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
      NEURON_ENABLE_CUSTOMER_REQUEST: "true",
      NEURON_ENABLE_LOCAL_STREAM: "true", NEURON_ENABLE_REMOTE_STREAM: "false",
      NEURON_SELLER_ACCOUNT_ID: "", NEURON_GATEWAY_WS_URL: "", NEURON_SESSION_TOKEN_FILE: "",
      NEURON_APP_ORIGIN: origin, NEURON_CUSTOMER_DB_FILE: join(directory, "auth.sqlite") },
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
  return fetch(origin + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

test("customer wallet challenge is origin-bound, one-use and durable across restart", async t => {
  const directory = mkdtempSync(join(tmpdir(), "neuron-customer-auth-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const port = await freePort();
  let app = await startApp("testnet", directory, port);
  try {
    const wallet = Wallet.createRandom();
    assert.equal((await post(app.origin, "/api/customer-auth/challenge", { address: wallet.address },
      { Origin: "http://wrong.example" })).status, 403);
    assert.equal((await post(app.origin, "/api/customer-auth/challenge", { address: "bad" })).status, 400);
    assert.equal((await post(app.origin, "/api/customer-auth/challenge", { address: "x".repeat(3000) })).status, 413);
    assert.equal((await post(app.origin, "/api/customer-auth/challenge", undefined)).status, 400);
    const challengeResponse = await post(app.origin, "/api/customer-auth/challenge", { address: wallet.address });
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json();
    assert.equal(challenge.chainId, 296);
    assert.match(challenge.message, /does not authorize a payment/);
    assert.match(challenge.message, new RegExp(wallet.address));
    assert.equal((await post(app.origin, "/api/customer-auth/verify", {
      challengeId: challenge.challengeId, signature: await wallet.signMessage("different message"),
    })).status, 401);
    const signed = await wallet.signMessage(challenge.message);
    const results = await Promise.all([post(app.origin, "/api/customer-auth/verify", {
      challengeId: challenge.challengeId, signature: signed,
    }), post(app.origin, "/api/customer-auth/verify", {
      challengeId: challenge.challengeId, signature: signed,
    })]);
    assert.deepEqual(results.map(row => row.status).sort(), [200, 401]);
    const success = results.find(row => row.status === 200);
    const session = await success.json();
    assert.equal(session.ownerAddress, wallet.address);
    const setCookie = success.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly; SameSite=Strict/);
    const cookie = setCookie.split(";")[0];
    assert.match(cookie, /^neuron_session_dev=[0-9a-f]{64}$/);
    const current = await fetch(app.origin + "/api/customer-auth/session", { headers: { Cookie: cookie } });
    assert.equal(current.status, 200);
    assert.equal((await current.json()).sessionId, session.sessionId);
    assert.equal(statSync(join(directory, "auth.sqlite")).mode & 0o777, 0o600);

    const ticketWithoutCookie = await post(app.origin, "/api/local-stream-ticket", undefined);
    assert.equal(ticketWithoutCookie.status, 401);
    const ticketWithCookie = await post(app.origin, "/api/local-stream-ticket", undefined, { Cookie: cookie });
    assert.equal(ticketWithCookie.status, 503);
    assert.equal((await fetch(app.origin + "/api/customer-request")).status, 401);
    assert.equal((await post(app.origin, "/api/customer-request", undefined)).status, 401);
    assert.equal((await post(app.origin, "/api/customer-request", undefined,
      { Cookie: cookie, Origin: "http://wrong.example" })).status, 403);
    assert.equal((await post(app.origin, "/api/customer-request", { seller: "0.0.4318411" },
      { Cookie: cookie })).status, 400);
    const emptyRequest = await fetch(app.origin + "/api/customer-request", { headers: { Cookie: cookie } });
    assert.equal(emptyRequest.status, 503);
    assert.equal((await post(app.origin, "/api/customer-request", undefined, { Cookie: cookie })).status, 503);

    await stopApp(app.child);
    app = await startApp("testnet", directory, port);
    assert.equal((await fetch(app.origin + "/api/customer-auth/session", { headers: { Cookie: cookie } })).status, 200);

    await stopApp(app.child);
    const otherOrigin = await startApp("testnet", directory, await freePort());
    try {
      assert.equal((await fetch(otherOrigin.origin + "/api/customer-auth/session", { headers: { Cookie: cookie } })).status, 401);
    } finally {
      await stopApp(otherOrigin.child);
    }
    app = await startApp("testnet", directory, port);
    assert.equal((await fetch(app.origin + "/api/customer-auth/session", { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await post(app.origin, "/api/customer-auth/logout", undefined,
      { Cookie: cookie, Origin: "http://wrong.example" })).status, 403);
    assert.equal((await post(app.origin, "/api/customer-auth/logout", undefined, { Cookie: cookie })).status, 200);
    assert.equal((await fetch(app.origin + "/api/customer-auth/session", { headers: { Cookie: cookie } })).status, 401);

    chmodSync(directory, 0o755);
    assert.equal((await post(app.origin, "/api/customer-auth/challenge", { address: wallet.address })).status, 503);
    chmodSync(directory, 0o700);
  } finally {
    await stopApp(app.child);
  }

  app = await startApp("mainnet", directory, port);
  try {
    assert.equal((await post(app.origin, "/api/customer-auth/challenge", { address: Wallet.createRandom().address })).status, 404);
    assert.equal((await post(app.origin, "/api/customer-request", undefined)).status, 404);
  } finally {
    await stopApp(app.child);
  }
});
