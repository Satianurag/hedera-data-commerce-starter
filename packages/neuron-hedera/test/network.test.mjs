import assert from "node:assert/strict";
import test from "node:test";
import { getMirrorTopic, networkConfigFromEnv } from "../dist/index.js";

test("testnet and mainnet use distinct real Mirror endpoints", () => {
  const testnet = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  const mainnet = networkConfigFromEnv({ HEDERA_NETWORK: "mainnet" });
  assert.equal(testnet.mirrorBaseUrl, "https://testnet.mirrornode.hedera.com");
  assert.equal(mainnet.mirrorBaseUrl, "https://mainnet.mirrornode.hedera.com");
  assert.ok(testnet.legacyDirectoryUrl);
  assert.equal(mainnet.legacyDirectoryUrl, undefined);
});

test("known cross-network Mirror URL fails closed", () => {
  assert.throws(() => networkConfigFromEnv({
    HEDERA_NETWORK: "mainnet",
    HEDERA_MIRROR_URL: "https://testnet.mirrornode.hedera.com",
  }), /not approved/);
});

test("unknown Mirror and wrong-network directory fail closed", () => {
  assert.throws(() => networkConfigFromEnv({
    HEDERA_NETWORK: "mainnet",
    HEDERA_MIRROR_URL: "https://example.com",
  }), /not approved/);
  assert.throws(() => networkConfigFromEnv({
    HEDERA_NETWORK: "mainnet",
    NEURON_LEGACY_DIRECTORY_URL: "https://explorer.neuron.world/api/v1/device/wip-all",
  }), /not approved/);
});

test("forged config cannot reach Mirror", async () => {
  await assert.rejects(getMirrorTopic({
    network: "mainnet",
    mirrorBaseUrl: "https://example.com",
  }, "0.0.1"), /not approved/);
});
