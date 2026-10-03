import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as hedera from "@neuron/hedera";
import * as profileFiles from "@neuron/hedera/direct-seller-file";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../lib/customer-request.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Configuration boundary test with mocked Mirror reads; no HCS or wallet writes.
test("request descriptor refuses malformed/public-policy configuration before any Mirror or executable call", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "request-config-"));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "must-not-execute");
  writeFileSync(binary, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const env = {
    HEDERA_NETWORK: "testnet",
    HEDERA_MAX_FEE_TINYBAR: "1000",
    NEURON_SELLER_ACCOUNT_ID: "0.0.100",
    NEURON_SELLER_STDIN_TOPIC_ID: "0.0.101",
    HEDERA_BUYER_ACCOUNT_ID: "0.0.200",
    HEDERA_BUYER_STDIN_TOPIC_ID: "0.0.201",
    HEDERA_SHARED_ACCOUNT_ID: "0.0.202",
    HEDERA_OPERATOR_ACCOUNT_ID: "0.0.203",
    HEDERA_BUYER_KEY_FILE: join(dir, "buyer"),
    HEDERA_OPERATOR_KEY_FILE: join(dir, "operator"),
    NEURON_LEGACY_REQUEST_BIN: binary,
    NEURON_HCS_SUBMIT_BIN: binary,
    NEURON_PUBLIC_UDP_MULTIADDR: "/ip4/45.118.134.87/udp/4001/quic-v1",
  };
  let mirrorReads = 0;
  const commonjs = { exports: {} };
  vm.runInNewContext(compiled, {
    module: commonjs,
    exports: commonjs.exports,
    process: { env, getuid: process.getuid?.bind(process) },
    URL,
    Buffer,
    require(name) {
      if (name === "@neuron/hedera/direct-seller-file") return profileFiles;
      if (name === "@neuron/hedera")
        return {
          ...hedera,
          getMirrorAccount: async () => {
            mirrorReads++;
            return {};
          },
          getMirrorTopic: async () => {
            mirrorReads++;
            return { submit_key: null };
          },
          checkDirectSellerBinding: async () => {
            mirrorReads++;
          },
        };
      if (name === "./customer-auth" || name === "./gateway-endpoint") return {};
      return require(name);
    },
  });
  const preflight = commonjs.exports.preflightCustomerRequestDescriptor;
  for (const address of [
    "/ip4/999.999.999.999/udp/99999/quic-v1",
    "/ip4/8.8.8.8/udp/65536/quic-v1",
    "/ip4/169.254.169.254/udp/4001/quic-v1",
    "/ip4/127.0.0.1/udp/4001/quic-v1",
    "/ip4/203.0.113.1/udp/4001/quic-v1",
  ]) {
    env.NEURON_PUBLIC_UDP_MULTIADDR = address;
    await assert.rejects(preflight(), /UDP|IPv4/);
  }
  assert.equal(mirrorReads, 0);
  env.NEURON_PUBLIC_UDP_MULTIADDR = "/ip4/45.118.134.87/udp/4001/quic-v1";
  await preflight();
  assert.equal(mirrorReads, 6);
  const profile = join(dir, "profile.json");
  writeFileSync(
    profile,
    JSON.stringify({
      schema: "neuronDirectSeller/v1",
      network: "testnet",
      chainId: 296,
      accountId: "0.0.100",
      publicKey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      stdinTopicId: "0.0.101",
      stdoutTopicId: "0.0.102",
      quoteTopicId: "0.0.103",
      serviceId: "1",
      protocol: "neuron/ADSB/0.0.2",
      paymentProtocol: "neuronCustomerQuote/v1",
      transport: "loopback",
    }),
    { mode: 0o600 },
  );
  Object.assign(env, {
    NEURON_SELLER_DISCOVERY: "direct",
    NEURON_DIRECT_SELLER_PROFILE_FILE: profile,
    NEURON_ENABLE_LOCAL_STREAM: "true",
    NEURON_APP_ORIGIN: "http://127.0.0.1:3000",
    NEURON_GATEWAY_WS_URL: "ws://127.0.0.1:9550/stream",
    NEURON_PUBLIC_UDP_MULTIADDR: "/ip4/127.0.0.1/udp/4001/quic-v1",
  });
  await preflight();
  assert.equal(mirrorReads, 13);
  env.NEURON_PUBLIC_UDP_MULTIADDR = "/ip4/127.0.0.2/udp/4001/quic-v1";
  await assert.rejects(preflight(), /127.0.0.1/);
  assert.equal(mirrorReads, 13);
});
