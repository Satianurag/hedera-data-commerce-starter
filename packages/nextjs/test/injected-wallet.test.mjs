import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(fileURLToPath(new URL("../app/wallet/injected.ts", import.meta.url)), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(saved = new Map()) {
  const listeners = new Map();
  const timers = [];
  const browser = {
    localStorage: {
      getItem: key => saved.get(key) ?? null,
      setItem: (key, value) => saved.set(key, value),
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
    setTimeout(fn) { timers.push(fn); },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, { window: browser, Event, module, exports: module.exports });
  return { api: module.exports, browser, flushTimers: () => timers.splice(0).forEach(fn => fn()) };
}

function provider() {
  const listeners = new Map();
  return {
    async request() { return null; },
    on(type, fn) { listeners.set(type, fn); },
    removeListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    emit(type) { listeners.get(type)?.(); },
  };
}

function announce(browser, uuid, name, rdns, injected) {
  browser.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), {
    detail: { info: { uuid, name, rdns }, provider: injected },
  }));
}

test("two injected wallets require selection and only the selected provider can authorize actions", () => {
  const { api, browser, flushTimers } = fixture();
  const first = provider();
  const second = provider();
  browser.addEventListener("eip6963:requestProvider", () => {
    announce(browser, "wallet-a", "Wallet A", "example.a", first);
    announce(browser, "wallet-b", "Wallet B", "example.b", second);
  });
  api.discoverInjectedWallets();
  flushTimers();
  assert.equal(api.walletSnapshot().choices.length, 2);
  assert.equal(api.walletSnapshot().selectedId, null);
  assert.throws(() => api.selectedInjectedWallet(), /Choose the wallet/);
  const invalidations = [];
  api.subscribeWalletInvalidation(reason => invalidations.push(reason));
  api.selectInjectedWallet("eip6963:wallet-a");
  const selected = api.selectedInjectedWallet();
  assert.equal(selected.provider, first);
  second.emit("chainChanged");
  api.assertInjectedWallet(first, selected.revision);
  first.emit("accountsChanged");
  assert.throws(() => api.assertInjectedWallet(first, selected.revision), /changed/);
  api.selectInjectedWallet("eip6963:wallet-b");
  assert.equal(api.selectedInjectedWallet().provider, second);
  assert.throws(() => api.assertInjectedWallet(first, api.walletSnapshot().revision), /changed/);
  assert.deepEqual(invalidations, ["selection", "provider", "selection"]);
});

test("saved choice never restores silently; a replaced legacy provider fails closed", () => {
  const saved = new Map([["neuron-injected-wallet:testnet", "eip6963:example.a:Wallet A"]]);
  const unique = fixture(saved);
  unique.browser.addEventListener("eip6963:requestProvider", () => {
    announce(unique.browser, "one", "Wallet A", "example.a", provider());
  });
  unique.api.discoverInjectedWallets();
  assert.equal(unique.api.walletSnapshot().selectedId, null);
  assert.throws(() => unique.api.selectedInjectedWallet(), /required/);
  unique.flushTimers();
  assert.equal(unique.api.walletSnapshot().selectedId, null);
  unique.api.selectInjectedWallet("eip6963:one");
  assert.equal(unique.api.walletSnapshot().selectedId, "eip6963:one");
  announce(unique.browser, "two", "Wallet A", "example.a", provider());
  assert.equal(unique.api.walletSnapshot().selectedId, null);

  const legacy = fixture();
  const first = provider();
  legacy.browser.ethereum = first;
  legacy.api.discoverInjectedWallets();
  legacy.flushTimers();
  assert.equal(legacy.api.walletSnapshot().selectedId, null);
  legacy.api.selectInjectedWallet("legacy");
  assert.equal(legacy.api.selectedInjectedWallet().provider, first);
  legacy.browser.ethereum = provider();
  assert.throws(() => legacy.api.selectedInjectedWallet(), /changed/);
  assert.equal(legacy.api.walletSnapshot().selectedId, null);
  assert.equal(legacy.api.walletSnapshot().choices.length, 1);
});

test("UUID collision removes the selected provider", () => {
  const saved = new Map();
  const { api, browser, flushTimers } = fixture(saved);
  const original = provider();
  browser.addEventListener("eip6963:requestProvider", () => {
    announce(browser, "collision", "Wallet A", "example.a", original);
  });
  api.discoverInjectedWallets();
  assert.equal(api.walletSnapshot().selectedId, null);
  flushTimers();
  api.selectInjectedWallet("eip6963:collision");
  const chosen = api.selectedInjectedWallet();
  assert.equal(chosen.provider, original);
  announce(browser, "collision", "Wallet A", "example.a", provider());
  assert.equal(api.walletSnapshot().selectedId, null);
  assert.equal(api.walletSnapshot().choices.length, 0);
  assert.equal(api.walletSnapshot().conflict, true);
  assert.throws(() => api.assertInjectedWallet(original, chosen.revision), /required/);
  assert.equal(saved.has("neuron-injected-wallet:testnet"), false);
  announce(browser, "collision", "Wallet A", "example.a", original);
  assert.equal(api.walletSnapshot().choices.length, 0);
  announce(browser, "new-uuid", "Wallet A", "example.a", provider());
  assert.equal(api.walletSnapshot().selectedId, null);
  assert.equal(api.walletSnapshot().choices.length, 1);
});

test("asynchronous second provider prevents a transient single-wallet auto-selection", () => {
  const { api, browser, flushTimers } = fixture();
  browser.addEventListener("eip6963:requestProvider", () => {
    announce(browser, "first", "Wallet A", "example.a", provider());
  });
  api.discoverInjectedWallets();
  assert.equal(api.walletSnapshot().selectedId, null);
  assert.throws(() => api.selectedInjectedWallet(), /required/);
  announce(browser, "second", "Wallet B", "example.b", provider());
  flushTimers();
  assert.equal(api.walletSnapshot().selectedId, null);
  assert.throws(() => api.selectedInjectedWallet(), /Choose the wallet/);
});

test("provider without account/network change events cannot be selected", () => {
  const { api, browser, flushTimers } = fixture();
  const eventless = { async request() { return null; } };
  browser.ethereum = eventless;
  browser.addEventListener("eip6963:requestProvider", () => {
    announce(browser, "eventless", "Eventless wallet", "example.eventless", eventless);
  });
  api.discoverInjectedWallets();
  flushTimers();
  assert.equal(api.walletSnapshot().choices.length, 0);
  assert.throws(() => api.selectInjectedWallet("eip6963:eventless"), /unavailable/);
  assert.throws(() => api.selectedInjectedWallet(), /required/);
});

test("losing event support after selection invalidates the provider", () => {
  const { api, browser, flushTimers } = fixture();
  const injected = provider();
  browser.addEventListener("eip6963:requestProvider", () => {
    announce(browser, "mutable", "Mutable wallet", "example.mutable", injected);
  });
  api.discoverInjectedWallets();
  flushTimers();
  api.selectInjectedWallet("eip6963:mutable");
  injected.on = undefined;
  assert.throws(() => api.selectedInjectedWallet(), /cannot report/);
  assert.equal(api.walletSnapshot().selectedId, null);
});

test("a provider that rejects event subscription cannot remain selected", () => {
  const { api, browser, flushTimers } = fixture();
  const injected = provider();
  injected.on = () => { throw new Error("Subscription rejected"); };
  browser.addEventListener("eip6963:requestProvider", () => {
    announce(browser, "throwing", "Throwing wallet", "example.throwing", injected);
  });
  api.discoverInjectedWallets();
  flushTimers();
  assert.throws(() => api.selectInjectedWallet("eip6963:throwing"), /cannot report/);
  assert.equal(api.walletSnapshot().selectedId, null);
});

test("WalletConnect selection is removed on chain change and cannot be revived by a stale provider", () => {
  const { api } = fixture();
  const first = provider();
  api.registerWalletConnect(first);
  const selected = api.selectedInjectedWallet();
  assert.equal(selected.provider, first);
  first.emit("chainChanged");
  assert.throws(() => api.assertInjectedWallet(first, selected.revision), /changed/);
  api.removeWalletConnect(first);
  assert.equal(api.walletSnapshot().selectedId, null);
  assert.equal(api.walletSnapshot().choices.length, 0);

  const second = provider();
  api.registerWalletConnect(second);
  api.removeWalletConnect(first);
  assert.equal(api.selectedInjectedWallet().provider, second);
  api.removeWalletConnect(second);
  assert.equal(api.walletSnapshot().selectedId, null);
});
