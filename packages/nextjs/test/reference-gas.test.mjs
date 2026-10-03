import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../lib/reference-gas.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const context = { exports: {}, setTimeout, clearTimeout };
vm.runInNewContext(compiled, context);
const { referenceGasLimits, prepareReferenceGas } = context.exports;
const hex = (value) => `0x${BigInt(value).toString(16)}`;

test("observed refund gas estimate receives a buffer within the exact fee and balance caps", () => {
  const result = referenceGasLimits(
    hex(64563),
    hex(1_140_000_000_000n),
    hex(500_000_000_000_000_000n),
  );
  assert.equal(BigInt(result.gas), 106_845n);
  assert.equal(BigInt(result.maximumFeeWei), 121_803_300_000_000_000n);
  assert.equal(result.gasPrice, hex(1_140_000_000_000n));
  assert.equal(
    referenceGasLimits(hex(260000), hex(1_250_000_000_000n), hex(500_000_000_000_000_000n)).gas,
    hex(400000),
  );
  assert.throws(
    () => referenceGasLimits(hex(260001), "0x1", hex(500_000_000_000_000_000n)),
    /gas limit/,
  );
  assert.throws(
    () => referenceGasLimits(hex(260000), hex(1_250_000_000_001n), hex(10n ** 18n)),
    /0.5 HBAR/,
  );
  assert.throws(() => referenceGasLimits(hex(64563), "0x1", hex(106844)), /balance/);
  assert.equal(referenceGasLimits(hex(64563), "0x1", hex(106845)).maximumFeeWei, "106845");
});

test("malformed, negative, overlong and zero gas quantities fail closed", () => {
  for (const bad of [
    64563,
    null,
    "",
    "64563",
    "-1",
    "0x-1",
    "0x00",
    "0xz",
    `0x1${"0".repeat(64)}`,
  ]) {
    for (let index = 0; index < 3; index++) {
      const values = [hex(64563), "0x1", hex(10n ** 18n)];
      values[index] = bad;
      assert.throws(() => referenceGasLimits(...values), /invalid/);
    }
  }
  assert.throws(() => referenceGasLimits("0x0", "0x1", hex(10n ** 18n)), /positive/);
  assert.throws(() => referenceGasLimits(hex(64563), "0x0", hex(10n ** 18n)), /positive/);
});

test("gas preparation preserves the immutable transaction and only makes read-only RPC requests", async () => {
  const transaction = Object.freeze({
    kind: "refund",
    label: "Refund",
    chainId: 296,
    to: "0x2222222222222222222222222222222222222222",
    data: "0xabcdef",
    value: "0x0",
    nonce: "0x6",
  });
  const from = "0x1111111111111111111111111111111111111111";
  const calls = [];
  const provider = {
    request: async (request) => {
      calls.push(request);
      return { eth_estimateGas: hex(64563), eth_gasPrice: "0x1", eth_getBalance: hex(10n ** 18n) }[
        request.method
      ];
    },
  };
  assert.equal((await prepareReferenceGas(provider, from, transaction)).gas, hex(106845));
  assert.deepEqual(
    calls.map((call) => call.method).sort(),
    ["eth_estimateGas", "eth_gasPrice", "eth_getBalance"].sort(),
  );
  assert.equal(calls[0].params[0].nonce, transaction.nonce);
  assert.equal(calls[0].params[0].to, transaction.to);
  assert.equal(calls[0].params[0].data, transaction.data);
  assert.equal(calls[0].params[0].value, transaction.value);
  await assert.rejects(
    () => prepareReferenceGas(provider, from, { ...transaction, nonce: undefined }),
    /nonce-bound/,
  );
});
