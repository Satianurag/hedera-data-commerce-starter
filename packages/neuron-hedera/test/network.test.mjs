import assert from "node:assert/strict";
import test from "node:test";
import { getMirrorContract, getMirrorTopic, networkConfigFromEnv } from "../dist/index.js";

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

test("Mirror contract metadata returns the exact ID and EVM address from the selected network", async t => {
  const requests = [];
  const address = "0xbdAE06d4309E18634B1e227B969Fe7cA410E297B";
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url: String(url), redirect: options.redirect });
    return Response.json({ contract_id: "0.0.10730636", deleted: false, evm_address: address });
  });

  const contract = await getMirrorContract(networkConfigFromEnv({ HEDERA_NETWORK: "testnet" }), "0.0.10730636");
  assert.equal(contract.contract_id, "0.0.10730636");
  assert.equal(contract.evm_address, address);
  assert.deepEqual(requests, [{
    url: "https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10730636",
    redirect: "error",
  }]);
});

test("Mirror contract metadata rejects a wrong ID, deleted record and malformed EVM address", async t => {
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  let metadata;
  t.mock.method(globalThis, "fetch", async () => Response.json(metadata));
  for (const invalid of [
    { contract_id: "0.0.9", deleted: false, evm_address: "0x" + "a".repeat(40) },
    { contract_id: "0.0.8", deleted: true, evm_address: "0x" + "a".repeat(40) },
    { contract_id: "0.0.8", deleted: false, evm_address: "0x1234" },
  ]) {
    metadata = invalid;
    await assert.rejects(getMirrorContract(config, "0.0.8"), /missing, deleted or malformed/);
  }
});

test("Mirror contract reads honor the network boundary before fetching", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async url => {
    requests.push(String(url));
    return Response.json({ contract_id: "0.0.8", deleted: false,
      evm_address: "0x" + "a".repeat(40) });
  });
  await getMirrorContract(networkConfigFromEnv({ HEDERA_NETWORK: "mainnet" }), "0.0.8");
  assert.deepEqual(requests, ["https://mainnet.mirrornode.hedera.com/api/v1/contracts/0.0.8"]);

  await assert.rejects(getMirrorContract({
    network: "mainnet", chainId: 295,
    mirrorBaseUrl: "https://testnet.mirrornode.hedera.com",
  }, "0.0.8"), /not approved/);
  assert.equal(requests.length, 1);
});
