import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { Core } from "@walletconnect/core";

function lifecycle(context = {}) {
  const source = readFileSync(new URL("../app/wallet/walletconnect-lifecycle.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const commonjs = { exports: {} };
  vm.runInNewContext(compiled, { module: commonjs, exports: commonjs.exports, setTimeout, clearTimeout, ...context });
  return commonjs.exports;
}

test("real SDK Heartbeat and idle relay reuse stops intervals without adding global Core entries", async () => {
  const active = new Set(), realSet = globalThis.setInterval, realClear = globalThis.clearInterval;
  const prefix = `neuron-lifecycle-test-${crypto.randomUUID()}`;
  const items = new Map();
  const storage = { async getKeys() { return [...items.keys()]; }, async getItem(key) { return items.get(key); },
    async setItem(key, value) { items.set(key, value); }, async removeItem(key) { items.delete(key); } };
  globalThis.setInterval = (...args) => { const id = realSet(...args); active.add(id); return id; };
  globalThis.clearInterval = id => { active.delete(id); return realClear(id); };
  let core;
  try {
    core = new Core({ projectId: "a".repeat(32), customStoragePrefix: prefix, storage, logger: "silent", telemetryEnabled: false });
    let relayCloses = 0;
    const closeTransport = core.relayer.transportClose.bind(core.relayer);
    core.relayer.transportClose = async () => { relayCloses++; await closeTransport(); };
    const provider = { client: { core }, session: undefined, async cleanupPendingPairings() {} };
    const { closeWalletConnectProvider } = lifecycle();
    const entries = Object.keys(globalThis).filter(key => key.includes(prefix));
    for (let attempt = 0; attempt < 5; attempt++) {
      await core.heartbeat.init();
      // No topics and no Core.start(): the real public API opens no relay socket.
      await core.relayer.transportOpen();
      assert.equal(active.size, 1, "the actual installed Heartbeat owns one interval");
      assert.equal(await closeWalletConnectProvider(provider), true);
      assert.equal(active.size, 0, "cleanup clears the actual SDK interval");
      assert.equal(core.relayer.transportExplicitlyClosed, true);
      assert.deepEqual(Object.keys(globalThis).filter(key => key.includes(prefix)), entries);
    }
    assert.equal(relayCloses, 5);
  } finally {
    core?.heartbeat.stop();
    for (const id of active) realClear(id);
    globalThis.setInterval = realSet; globalThis.clearInterval = realClear;
  }
});

test("disconnect and relay stalls are bounded and cannot bypass heartbeat stop or pairing cleanup", async () => {
  let id = 0, stops = 0, pairings = 0, relayCloses = 0;
  const timers = new Map();
  const api = lifecycle({ setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(key) { timers.delete(key); } });
  const provider = { session: {}, client: { core: { heartbeat: { stop() { stops++; } },
    relayer: { transportClose() { relayCloses++; return new Promise(() => {}); } } } },
    disconnect() { return new Promise(() => {}); }, async cleanupPendingPairings() { pairings++; } };
  const closing = api.closeWalletConnectProvider(provider);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(stops > 0, "heartbeat stops immediately before a remote disconnect can stall");
  assert.equal(pairings, 1);
  for (const callback of [...timers.values()]) callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relayCloses, 1);
  for (const callback of [...timers.values()]) callback();
  assert.equal(await closing, false);
  assert.equal(timers.size, 0);
  assert.ok(stops >= 3);
});

test("rejected disconnect still executes pairing cleanup and relay shutdown", async () => {
  let closed = 0, pairings = 0, stopped = 0;
  const provider = { session: {}, client: { core: { heartbeat: { stop() { stopped++; } }, relayer: { async transportClose() { closed++; } } } },
    async disconnect() { throw new Error("offline"); }, async cleanupPendingPairings() { pairings++; } };
  assert.equal(await lifecycle().closeWalletConnectProvider(provider), false);
  assert.equal(closed, 1); assert.equal(pairings, 1); assert.ok(stopped >= 3);
});
