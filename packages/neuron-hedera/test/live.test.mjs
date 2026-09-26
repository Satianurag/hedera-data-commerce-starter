import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkLegacyDeviceBinding, getLatestTopicMessage, getMirrorAccount, inspectSignedTopicEnvelope, listLegacyDevices, networkConfigFromEnv } from "../dist/index.js";
import { mirrorJson } from "../dist/mirror.js";

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

test("controlled signed TopicMessage matches testnet Mirror payer key", async () => {
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  const row = await mirrorJson(config, "/api/v1/topics/0.0.10725147/messages/5");
  assert.equal(row.topic_id, "0.0.10725147");
  assert.equal(row.payer_account_id, "0.0.10725146");
  const bytes = Buffer.from(row.message, "base64");
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "770d8fc563b5106227e97d9d6a527996dbe24375123324ca19f1d8770217d93c");
  const signed = inspectSignedTopicEnvelope(bytes);
  assert.ok(signed);
  assert.equal(signed.senderAddress, "0xD5165317aA5F8fDA9735d59956d839BEA0730D4A");
  const payer = await getMirrorAccount(config, row.payer_account_id);
  assert.equal(payer.key._type, "ECDSA_SECP256K1");
  assert.equal(payer.key.key.toLowerCase(), signed.compressedPublicKey.toLowerCase());
});

test("mainnet configuration reads a real mainnet Mirror account", async () => {
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "mainnet" });
  const account = await getMirrorAccount(config, "0.0.2");
  assert.equal(account.account, "0.0.2");
  assert.equal(account.deleted, false);
  assert.equal(config.legacyDirectoryUrl, undefined);
});
