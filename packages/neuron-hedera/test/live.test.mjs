import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { checkLegacyDeviceBinding, getLatestTopicMessage, getTopicMessageBySequence, getMirrorAccount, inspectSignedTopicEnvelope, listLegacyDevices, networkConfigFromEnv } from "../dist/index.js";

// These checks only read public endpoints. Optional fixtures belong to the
// developer running the suite; no audit account or topic is a template default.
function fixtureFromEnv(prefix, context) {
  const names = ["TOPIC_ID", "FINAL_SEQUENCE", "PAYER_ACCOUNT_ID", "BYTE_LENGTH", "SHA256"];
  const values = Object.fromEntries(names.map(name => [name, process.env[`${prefix}_${name}`]?.trim()]));
  if (Object.values(values).every(value => !value)) {
    context.skip(`Set ${names.map(name => `${prefix}_${name}`).join(", ")} for a real testnet fixture`);
    return null;
  }
  for (const name of names) assert.ok(values[name], `${prefix}_${name} is required when any fixture field is set`);
  assert.match(values.TOPIC_ID, /^0\.0\.\d+$/, `${prefix}_TOPIC_ID must be a Hedera ID`);
  assert.match(values.PAYER_ACCOUNT_ID, /^0\.0\.\d+$/, `${prefix}_PAYER_ACCOUNT_ID must be a Hedera ID`);
  assert.match(values.FINAL_SEQUENCE, /^[1-9]\d*$/, `${prefix}_FINAL_SEQUENCE must be a positive integer`);
  assert.match(values.BYTE_LENGTH, /^[1-9]\d*$/, `${prefix}_BYTE_LENGTH must be a positive integer`);
  assert.match(values.SHA256, /^[a-fA-F0-9]{64}$/, `${prefix}_SHA256 must be a SHA-256 hex digest`);
  const sequence = Number(values.FINAL_SEQUENCE);
  const byteLength = Number(values.BYTE_LENGTH);
  assert.ok(Number.isSafeInteger(sequence), `${prefix}_FINAL_SEQUENCE must be a safe integer`);
  assert.ok(Number.isSafeInteger(byteLength) && byteLength <= 20 * 1024,
    `${prefix}_BYTE_LENGTH must fit the reader's 20-chunk bound`);
  return { topicId: values.TOPIC_ID, sequence, payerAccountId: values.PAYER_ACCOUNT_ID,
    byteLength, sha256: values.SHA256.toLowerCase() };
}

async function readFixture(fixture) {
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  const message = await getTopicMessageBySequence(config, fixture.topicId, fixture.sequence);
  assert.equal(message.topicId, fixture.topicId);
  assert.equal(message.payerAccountId, fixture.payerAccountId);
  assert.equal(message.sequenceNumber, fixture.sequence);
  assert.equal(message.bytes.length, fixture.byteLength);
  assert.equal(createHash("sha256").update(message.bytes).digest("hex"), fixture.sha256);
  return { config, message };
}

test("live testnet legacy directory is readable", async () => {
  const devices = await listLegacyDevices(networkConfigFromEnv({ HEDERA_NETWORK: "testnet" }));
  assert.ok(Array.isArray(devices));
  // An empty directory is a valid read, not proof of an available seller.
});

test("configured live legacy seller account key and HCS topics agree with testnet Mirror", async context => {
  const accountId = process.env.NEURON_LIVE_SELLER_ACCOUNT_ID?.trim();
  if (!accountId) {
    context.skip("Set NEURON_LIVE_SELLER_ACCOUNT_ID to check a real testnet legacy seller");
    return;
  }
  assert.match(accountId, /^0\.0\.\d+$/, "NEURON_LIVE_SELLER_ACCOUNT_ID must be a Hedera ID");
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  const devices = await listLegacyDevices(config);
  const seller = devices.find(device => device.accountId === accountId);
  assert.ok(seller, "configured seller is present in the current directory");
  assert.ok(seller.serviceIds.includes(1));
  await checkLegacyDeviceBinding(config, seller);
  const latest = await getLatestTopicMessage(config, seller.stdoutTopicId);
  assert.ok(latest, "seller has a real HCS message");
  assert.equal(latest.payerAccountId, seller.accountId);
  const body = JSON.parse(Buffer.from(latest.bytes).toString("utf8"));
  assert.equal(body.messageType, "NeuronHeartBeat");
});

test("configured real multi-chunk HCS message is reassembled exactly", async context => {
  const fixture = fixtureFromEnv("NEURON_LIVE_HCS", context);
  if (!fixture) return;
  assert.ok(fixture.byteLength > 1024, "NEURON_LIVE_HCS_BYTE_LENGTH must describe a multi-chunk message");
  await readFixture(fixture);
});

test("configured signed TopicMessage matches the current testnet Mirror payer key", async context => {
  const fixture = fixtureFromEnv("NEURON_LIVE_SIGNED", context);
  if (!fixture) return;
  const { config, message } = await readFixture(fixture);
  const signed = inspectSignedTopicEnvelope(message.bytes);
  assert.ok(signed);
  const payer = await getMirrorAccount(config, message.payerAccountId);
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
