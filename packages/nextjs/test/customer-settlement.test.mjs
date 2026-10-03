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
import { Interface, Wallet, getAddress } from "ethers";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const appDirectory = fileURLToPath(new URL("..", import.meta.url));
const mirror = "https://testnet.mirrornode.hedera.com";
const contractId = "0.0.10730636";
const contractAddress = "0xbdAE06d4309E18634B1e227B969Fe7cA410E297B";
const sellerId = "0.0.10725524";
const sellerAddress = "0x3938c6c903271ee751726e7aae07185e79c2ba2d";
const fundingHash = "0xaadbbbf784e6681f1c72b3c787ef1a8ed6f23ff9746c1cd6a8fce33f44a201c4";
const withdrawalHash = "0x81c2150b57c22ac33eb66424703a923a2e174250a939c3bd2cf6a50089e2611b";
const released = new Interface([
  "event Released(uint256 indexed id,address indexed seller,address to,uint256 amount)",
]);

async function getJson(path) {
  const response = await fetch(mirror + path, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200, path);
  return response.json();
}

// Explicit opt-in: the public Mirror is an external dependency and may be
// temporarily unavailable during an ordinary clean-copy test run.
test(
  "historical testnet withdrawal has one exact seller payout in Mirror",
  { skip: process.env.NEURON_LIVE_SETTLEMENT_TEST !== "1" },
  async () => {
    const [funding, withdrawal, actions, seller] = await Promise.all([
      getJson(`/api/v1/contracts/results/${fundingHash}`),
      getJson(`/api/v1/contracts/results/${withdrawalHash}`),
      getJson(`/api/v1/contracts/results/${withdrawalHash}/actions?limit=100`),
      getJson(`/api/v1/accounts/${sellerId}`),
    ]);
    assert.equal(funding.contract_id, contractId);
    assert.equal(funding.result, "SUCCESS");
    assert.equal(withdrawal.contract_id, contractId);
    assert.equal(withdrawal.result, "SUCCESS");
    assert.equal(seller.account, sellerId);
    assert.equal(getAddress(seller.evm_address), getAddress(sellerAddress));
    const events = withdrawal.logs.flatMap((log) => {
      if (log.contract_id !== contractId || getAddress(log.address) !== getAddress(contractAddress))
        return [];
      const event = released.parseLog(log);
      return event?.name === "Released" ? [event] : [];
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.id, 1n);
    assert.equal(getAddress(events[0].args.seller), getAddress(sellerAddress));
    assert.equal(getAddress(events[0].args.to), getAddress(sellerAddress));
    assert.equal(events[0].args.amount, 10_000_000n);
    assert.equal(actions.links.next, null);
    const transfers = actions.actions.filter((action) => action.value > 0);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].caller, contractId);
    assert.equal(transfers[0].recipient, sellerId);
    assert.equal(transfers[0].value, 10_000_000);
    assert.equal(transfers[0].timestamp, withdrawal.timestamp);
  },
);

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a paid journal row without reconciliation cannot claim a verified settlement", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "neuron-settlement-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: appDirectory,
    env: {
      ...process.env,
      HEDERA_NETWORK: "testnet",
      HEDERA_RPC_URL: "",
      NEURON_ENABLE_CUSTOMER_AUTH: "true",
      NEURON_ENABLE_CUSTOMER_COMMERCE_REVIEW: "true",
      NEURON_ENABLE_CUSTOMER_FUNDING: "true",
      NEURON_ENABLE_CUSTOMER_APPROVAL: "false",
      NEURON_APP_ORIGIN: origin,
      NEURON_CUSTOMER_DB_FILE: join(directory, "customer.sqlite"),
      NEURON_COMMERCE_SELLER_ACCOUNT_ID: sellerId,
      NEURON_SELLER_ACCOUNT_ID: sellerId,
      NEURON_COMMERCE_QUOTE_TOPIC_ID: "0.0.10",
      NEURON_COMMERCE_SERVICE_ID: "1",
      HEDERA_CONTRACT_ID: contractId,
      HEDERA_CONTRACT_ADDRESS: contractAddress,
      NEURON_COMMERCE_MAX_SPEND_TINYBAR: "10000000",
    },
    stdio: "ignore",
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    for (let i = 0; i < 30 && child.exitCode === null; i++) await delay(100);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null) break;
    try {
      ready = (await fetch(origin, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      /* boot */
    }
    if (ready) break;
    await delay(150);
  }
  assert.equal(ready, true, "Next production server did not boot");
  const wallet = Wallet.createRandom();
  const challengeResponse = await fetch(origin + "/api/customer-auth/challenge", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ address: wallet.address }),
  });
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  const verify = await fetch(origin + "/api/customer-auth/verify", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      signature: await wallet.signMessage(challenge.message),
    }),
  });
  assert.equal(verify.status, 200);
  const session = await verify.json();
  const cookie = verify.headers.get("set-cookie").split(";")[0];
  const empty = await fetch(origin + "/api/customer-funding", { headers: { Cookie: cookie } });
  assert.equal(empty.status, 200);
  const id = "a".repeat(32);
  const db = new Database(join(directory, "customer.sqlite"));
  try {
    db.prepare(
      `INSERT INTO customer_funding_intents
      (id, quote_intent_id, session_id, owner_address, origin, state, contract_state,
       contract_id, contract_address, seller_address, terms_hash, amount_tinybar,
       quote_expires_at, refund_after, prepared_block, scan_next_block, prepared_at,
       transaction_json, confirmed_hash, escrow_id, updated_at)
      VALUES (?, ?, ?, ?, ?, 'executed', 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "b".repeat(32),
      session.sessionId,
      session.ownerAddress,
      origin,
      contractId,
      contractAddress,
      sellerAddress,
      `0x${"c".repeat(64)}`,
      "10000000",
      1790432400,
      1790432538,
      1,
      1,
      1,
      "{}",
      fundingHash,
      "1",
      1,
    );
  } finally {
    db.close();
  }
  const response = await fetch(origin + `/api/customer-funding?id=${id}`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reconciliation, "unavailable");
  assert.equal(body.funding.contractState, "paid");
  assert.equal(body.funding.settlementHash, null);
  assert.equal(body.funding.settlementRecipientAddress, null);
  assert.equal(body.funding.settlementAmountTinybar, null);
  assert.equal(body.funding.settlementVerifiedAt, null);
});
