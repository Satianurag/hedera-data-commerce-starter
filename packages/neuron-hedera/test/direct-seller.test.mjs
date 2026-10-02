import { loadDirectSellerProfile } from "../dist/direct-seller-file.js";
import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAddress } from "ethers";
import { parseDirectSellerProfile, checkDirectSellerBinding, networkConfigFromEnv, assertSellerUDPAddress } from "../dist/index.js";

const key = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const profile = { schema: "neuronDirectSeller/v1", network: "testnet", chainId: 296,
  accountId: "0.0.100", publicKey: key, stdinTopicId: "0.0.101", stdoutTopicId: "0.0.102",
  quoteTopicId: "0.0.103", serviceId: "1", protocol: "neuron/ADSB/0.0.2",
  paymentProtocol: "neuronCustomerQuote/v1", transport: "public" };

test("seller UDP preflight rejects malformed and non-public targets before a request can be advertised", () => {
  const address = (ip, port = "4001") => `/ip4/${ip}/udp/${port}/quic-v1`;
  for (const ip of ["45.118.134.87", "8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0"]) {
    assert.doesNotThrow(() => assertSellerUDPAddress(address(ip)));
  }
  for (const ip of ["999.999.999.999", "256.1.1.1", "045.118.134.87", "0.1.2.3", "10.0.0.1",
    "100.64.0.0", "100.127.255.255", "127.0.0.1", "169.254.169.254", "172.16.0.0", "172.31.255.255",
    "192.168.1.1", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.255",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
    assert.throws(() => assertSellerUDPAddress(address(ip)), undefined, ip);
  }
  for (const port of ["0", "00", "04001", "65536", "99999", "-1", "+1"]) {
    assert.throws(() => assertSellerUDPAddress(address("45.118.134.87", port)));
  }
  for (const port of ["1", "65535"]) assert.doesNotThrow(() => assertSellerUDPAddress(address("45.118.134.87", port)));
  assert.doesNotThrow(() => assertSellerUDPAddress(address("127.0.0.1"), "loopback"));
  for (const ip of ["127.0.0.2", "45.118.134.87", "192.168.1.1"]) {
    assert.throws(() => assertSellerUDPAddress(address(ip), "loopback"));
  }
  for (const value of ["/dns4/example.org/udp/4001/quic-v1", "/ip6/::1/udp/4001/quic-v1", address("8.8.8.8") + "/p2p/example"]) {
    assert.throws(() => assertSellerUDPAddress(value));
  }
});

test("direct profile is explicit, strict and only supports the pinned native testnet protocol", () => {
  assert.deepEqual(parseDirectSellerProfile(profile), profile);
  for (const patch of [{ network: "mainnet" }, { chainId: 295 }, { serviceId: 1 }, { serviceId: "2" },
    { protocol: "other" }, { paymentProtocol: "Draft-008" }, { transport: "private" }, { stdinTopicId: "0.0.103" },
    { publicKey: `02${"ff".repeat(32)}` }, { publicKey: key.toUpperCase() }, { secret: "unexpected" },
    { accountId: "0.0.18446744073709551616" }, { accountId: "0.0.01" }]) {
    assert.throws(() => parseDirectSellerProfile({ ...profile, ...patch }));
  }
  assert.throws(() => parseDirectSellerProfile({ ...profile, quoteTopicId: undefined }));
});

test("direct mode refuses fallback, unsafe files and configuration conflicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "direct-profile-")); chmodSync(dir, 0o700);
  const file = join(dir, "seller.json"); writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
  const env = { HEDERA_NETWORK: "testnet", NEURON_SELLER_DISCOVERY: "direct", NEURON_DIRECT_SELLER_PROFILE_FILE: file };
  try {
    assert.equal(loadDirectSellerProfile({}), null);
    assert.deepEqual(loadDirectSellerProfile(env), profile);
    for (const patch of [{ NEURON_SELLER_DISCOVERY: "canonical" }, { NEURON_SELLER_DISCOVERY: "typo" },
      { HEDERA_NETWORK: "mainnet" }, { NEURON_SELLER_ACCOUNT_ID: "0.0.200" },
      { NEURON_SELLER_STDIN_TOPIC_ID: "0.0.200" }, { NEURON_COMMERCE_QUOTE_TOPIC_ID: "0.0.200" }]) {
      assert.throws(() => loadDirectSellerProfile({ ...env, ...patch }));
    }
    chmodSync(file, 0o644); assert.throws(() => loadDirectSellerProfile(env), /owner-only/); chmodSync(file, 0o600);
    const link = join(dir, "link.json"); symlinkSync(file, link);
    assert.throws(() => loadDirectSellerProfile({ ...env, NEURON_DIRECT_SELLER_PROFILE_FILE: link }), /owner-only/);
    writeFileSync(file, JSON.stringify(profile).replace('{', '{"network":"mainnet",'));
    assert.throws(() => loadDirectSellerProfile(env), /Duplicate/);
    writeFileSync(file, " ".repeat(16385)); assert.throws(() => loadDirectSellerProfile(env));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("loopback mode is confined to explicitly local frontend and gateway configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "direct-loopback-")); chmodSync(dir, 0o700);
  const file = join(dir, "seller.json"); writeFileSync(file, JSON.stringify({ ...profile, transport: "loopback" }), { mode: 0o600 });
  const env = { HEDERA_NETWORK: "testnet", NEURON_SELLER_DISCOVERY: "direct", NEURON_DIRECT_SELLER_PROFILE_FILE: file,
    NEURON_ENABLE_LOCAL_STREAM: "true", NEURON_APP_ORIGIN: "http://127.0.0.1:3000", NEURON_GATEWAY_WS_URL: "ws://127.0.0.1:9080/stream" };
  try {
    assert.equal(loadDirectSellerProfile(env).transport, "loopback");
    for (const patch of [{ NEURON_ENABLE_LOCAL_STREAM: "false" }, { NEURON_ENABLE_REMOTE_STREAM: "true" },
      { NEURON_APP_ORIGIN: "https://public.example" }, { NEURON_APP_ORIGIN: "http://192.168.1.1" },
      { NEURON_GATEWAY_WS_URL: "ws://192.168.1.1:9080/stream" }, { NEURON_GATEWAY_WS_URL: "ws://127.0.0.1:9080/stream?x=1" }]) {
      assert.throws(() => loadDirectSellerProfile({ ...env, ...patch }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("direct discovery requires current Mirror identity and open fee-free topics, without contacting a directory", async () => {
  const original = globalThis.fetch;
  const config = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });
  let accountPatch = {}, topicPatch = {};
  const contacted = [];
  globalThis.fetch = async input => {
    const url = String(input);
    contacted.push(url);
    assert.ok(url.startsWith("https://testnet.mirrornode.hedera.com/api/v1/"));
    if (url.includes("/accounts/")) return Response.json({ account: profile.accountId, deleted: false,
      key: { _type: "ECDSA_SECP256K1", key }, evm_address: computeAddress(`0x${key}`), ...accountPatch });
    return Response.json({ topic_id: url.split('/').at(-1), deleted: false, submit_key: null,
      custom_fees: { fixed_fees: [] }, ...topicPatch });
  };
  try {
    await checkDirectSellerBinding(config, profile); assert.equal(contacted.length, 4);
    for (const patch of [{ deleted: true }, { key: { _type: "ECDSA_SECP256K1", key: `03${key.slice(2)}` } },
      { evm_address: "0x0000000000000000000000000000000000000001" }]) {
      accountPatch = patch; await assert.rejects(checkDirectSellerBinding(config, profile));
    }
    accountPatch = {};
    for (const patch of [{ deleted: true }, { submit_key: {} }, { custom_fees: {} },
      { custom_fees: { fixed_fees: [{}] } }, { topic_id: "0.0.999" }]) {
      topicPatch = patch; await assert.rejects(checkDirectSellerBinding(config, profile));
    }
    await assert.rejects(checkDirectSellerBinding(networkConfigFromEnv({ HEDERA_NETWORK: "mainnet" }), profile));
  } finally { globalThis.fetch = original; }
});
