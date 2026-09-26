import assert from "node:assert/strict";
import test from "node:test";
import { getMirrorTopic, networkConfigFromEnv } from "../dist/index.js";

test("testnet and mainnet use distinct real Mirror endpoints", () => {
  const testnet = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  const mainnet = networkConfigFromEnv({ HEDERA_NETWORK: "mainnet" });
  assert.equal(testnet.mirrorBaseUrl, "https://testnet.mirrornode.hedera.com");
  assert.equal(mainnet.mirrorBaseUrl, "https://mainnet.mirrornode.hedera.com");
  assert.equal(testnet.chainId, 296);
  assert.equal(mainnet.chainId, 295);
  assert.ok(testnet.legacyDirectoryUrl);
  assert.equal(mainnet.legacyDirectoryUrl, undefined);
});

test("known cross-network Mirror URL fails closed", () => {
  assert.throws(() => networkConfigFromEnv({
    HEDERA_NETWORK: "mainnet",
    HEDERA_MIRROR_URL: "https://testnet.mirrornode.hedera.com",
  }), /not approved/);
});

test("configured EVM chain ID and forged config cannot cross networks", () => {
  assert.throws(() => networkConfigFromEnv({ HEDERA_NETWORK: "testnet", HEDERA_CHAIN_ID: "295" }), /does not match/);
  assert.throws(() => networkConfigFromEnv({ HEDERA_NETWORK: "mainnet", HEDERA_CHAIN_ID: "296" }), /does not match/);
  assert.throws(() => networkConfigFromEnv({ HEDERA_NETWORK: "testnet", HEDERA_CHAIN_ID: "0296" }), /does not match/);
  assert.equal(networkConfigFromEnv({ HEDERA_NETWORK: "testnet", HEDERA_CHAIN_ID: "296" }).chainId, 296);
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
    chainId: 295,
    mirrorBaseUrl: "https://example.com",
  }, "0.0.1"), /not approved/);
  await assert.rejects(getMirrorTopic({
    network: "mainnet",
    chainId: 296,
    mirrorBaseUrl: "https://mainnet.mirrornode.hedera.com",
  }, "0.0.1"), /not approved/);
});
