import assert from "node:assert/strict";
import test from "node:test";
import { listLegacyDevices, networkConfigFromEnv } from "../dist/index.js";

const config = networkConfigFromEnv({ HEDERA_NETWORK: "testnet" });

test("legacy directory rejects an oversized body before JSON parsing", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("x".repeat(1_048_577), { status: 200 });
  try {
    await assert.rejects(listLegacyDevices(config), /exceeds 1048576 bytes/);
  } finally {
    globalThis.fetch = original;
  }
});

test("legacy directory rejects more records than the page can serve", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(Array(1001).fill({})), { status: 200 });
  try {
    await assert.rejects(listLegacyDevices(config), /exceeds 1000 device records/);
  } finally {
    globalThis.fetch = original;
  }
});
