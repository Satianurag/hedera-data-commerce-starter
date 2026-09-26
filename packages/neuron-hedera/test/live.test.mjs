import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkLegacyDeviceBinding, getLatestTopicMessage, getMirrorAccount, listLegacyDevices, networkConfigFromEnv } from "../dist/index.js";

test("live legacy seller account key and HCS topics agree with testnet Mirror", async () => {
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  const devices = await listLegacyDevices(config);
  const seller = devices.find(device => device.accountId === "0.0.4318411");
  assert.ok(seller, "expected live seller is present in the directory");
  assert.ok(seller.serviceIds.includes(1));
  await checkLegacyDeviceBinding(config, seller);
  const latest = await getLatestTopicMessage(config, seller.stdoutTopicId);
  assert.ok(latest, "seller has a real HCS message");
  assert.equal(latest.payerAccountId, seller.accountId);
  const body = JSON.parse(Buffer.from(latest.bytes).toString("utf8"));
  assert.equal(body.messageType, "NeuronHeartBeat");
});

test("real multi-chunk HCS message is reassembled exactly", async () => {
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  const latest = await getLatestTopicMessage(config, "0.0.10713754");
  assert.ok(latest);
  assert.equal(latest.bytes.length, 2048);
  assert.equal(createHash("sha256").update(latest.bytes).digest("hex"),
    "412cd07cc67304a23c0cfc2212c551490daacf9b76dfe053cfed7dd2b05de2d7");
});

test("mainnet configuration reads a real mainnet Mirror account", async () => {
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "mainnet" });
  const account = await getMirrorAccount(config, "0.0.2");
  assert.equal(account.account, "0.0.2");
  assert.equal(account.deleted, false);
  assert.equal(config.legacyDirectoryUrl, undefined);
});
