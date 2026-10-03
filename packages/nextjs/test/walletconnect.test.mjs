import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const account = `0x${"12".repeat(20)}`;
const other = `0x${"34".repeat(20)}`;
const uri = `wc:${"ab".repeat(32)}@2?relay-protocol=irn&symKey=${"cd".repeat(32)}`;
const config = {
  projectId: "a".repeat(32),
  origin: "http://localhost:3000",
  chainId: 296,
  rpcUrl: "https://testnet.hashio.io/api",
};
function session(address = account) {
  return {
    expiry: Math.floor(Date.now() / 1000) + 3600,
    namespaces: {
      eip155: {
        accounts: [`eip155:296:${address}`],
        methods: ["personal_sign", "eth_sendTransaction"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  };
}
function load(name, context = {}) {
  const source = readFileSync(new URL(`../app/wallet/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const commonjs = { exports: {} };
  vm.runInNewContext(compiled, { module: commonjs, exports: commonjs.exports, ...context });
  return commonjs.exports;
}
const adapter = load("walletconnect-session");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(options = {}) {
  const events = new EventEmitter();
  const approval = deferred();
  const requested = deferred();
  const timers = new Map();
  const registered = [];
  const removed = [];
  let timerId = 0,
    coreCount = 0,
    initCount = 0;
  const core = {
    heartbeat: {
      stops: 0,
      starts: 0,
      stop() {
        this.stops++;
      },
      async init() {
        this.starts++;
      },
    },
    relayer: {
      closes: 0,
      opens: 0,
      async transportClose() {
        this.closes++;
      },
      async transportOpen() {
        this.opens++;
      },
    },
  };
  const raw = {
    session: undefined,
    disconnects: 0,
    cleanup: 0,
    options: null,
    initOptions: null,
    client: {
      core,
      session: {
        get length() {
          return raw.session ? 1 : 0;
        },
      },
    },
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    async connect(params) {
      this.options = params;
      requested.resolve();
      if (options.beforeURI) await options.beforeURI.promise;
      events.emit("display_uri", uri);
      this.session = await approval.promise;
    },
    async disconnect() {
      this.disconnects++;
      this.session = undefined;
      events.emit("disconnect");
    },
    async cleanupPendingPairings() {
      this.cleanup++;
    },
    async request(args, chain) {
      return { args, chain };
    },
  };
  const context = {
    window: { location: { origin: config.origin } },
    crypto: { randomUUID: () => "test-only-unique-attempt" },
    AbortSignal,
    setTimeout(fn, ms) {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    require(name) {
      if (name === "./walletconnect-session") return adapter;
      if (name === "./walletconnect-lifecycle") return load("walletconnect-lifecycle", context);
      if (name === "./injected")
        return {
          registerWalletConnect: (wallet) => registered.push(wallet),
          removeWalletConnect: (wallet) => removed.push(wallet),
        };
      if (name === "@walletconnect/core")
        return {
          Core: class {
            constructor() {
              coreCount++;
              return core;
            }
          },
        };
      if (name === "@walletconnect/universal-provider")
        return {
          UniversalProvider: {
            async init(params) {
              initCount++;
              raw.initOptions = params;
              await core.heartbeat.init();
              if (options.initialization) await options.initialization.promise;
              return raw;
            },
          },
        };
      throw new Error(`Unexpected module ${name}`);
    },
  };
  const api = load("walletconnect", context);
  return {
    api,
    raw,
    approval,
    requested: requested.promise,
    timers,
    registered,
    removed,
    events,
    core,
    counts: () => ({ coreCount, initCount }),
    fire(ms) {
      for (const item of [...timers.values()]) if (item.ms === ms) item.fn();
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Universal Provider adapter pins chain 296 and the approved account for every signature and transaction", async () => {
  const requests = [];
  const raw = {
    session: session(),
    on() {},
    removeListener() {},
    async request(args, chain) {
      requests.push({ args, chain });
      return "result";
    },
  };
  let active = true;
  const wallet = adapter.testnetWalletAdapter(raw, () => active);
  assert.equal((await wallet.request({ method: "eth_accounts" }))[0], account);
  assert.equal(await wallet.request({ method: "eth_chainId" }), "0x128");
  assert.equal(
    await wallet.request({ method: "personal_sign", params: ["0x1234", account] }),
    "result",
  );
  await wallet.request({
    method: "eth_sendTransaction",
    params: [{ from: account, chainId: "0x128" }],
  });
  assert.deepEqual(
    requests.map((request) => request.chain),
    ["eip155:296", "eip155:296"],
  );
  for (const args of [
    { method: "personal_sign", params: ["0x12", other] },
    { method: "eth_sendTransaction", params: [{ from: other }] },
    { method: "eth_sendTransaction", params: [{ from: account, chainId: "0x127" }] },
    { method: "eth_sendTransaction", params: [] },
    { method: "wallet_switchEthereumChain", params: [{ chainId: "0x127" }] },
  ])
    await assert.rejects(wallet.request(args), /account|network|malformed|not enabled/);
  raw.session = session(other);
  await assert.rejects(wallet.request({ method: "eth_accounts" }), /account changed/);
  raw.session = session();
  active = false;
  await assert.rejects(wallet.request({ method: "eth_accounts" }), /changed or disconnected/);
  assert.equal(requests.length, 2);
});

test("missing, expired, wrong-chain and incomplete sessions cannot become a selectable wallet", () => {
  const invalid = [null, {}, { ...session(), expiry: 1 }, { ...session(), expiry: Infinity }];
  const wrongChain = session();
  wrongChain.namespaces.eip155.accounts = [`eip155:295:${account}`];
  invalid.push(wrongChain);
  const noEvents = session();
  noEvents.namespaces.eip155.events = ["accountsChanged"];
  invalid.push(noEvents);
  const noSend = session();
  noSend.namespaces.eip155.methods = ["personal_sign"];
  invalid.push(noSend);
  for (const value of invalid)
    assert.throws(() => adapter.approvedTestnetAccount(value), /session|approve/);
});

test("connection requests current optional namespaces, displays local URI, and invalidates on session update", async () => {
  const f = fixture(),
    displayed = [];
  const connecting = f.api.connectWalletConnect(config, (value) => displayed.push(value));
  await f.requested;
  assert.equal(displayed[0], uri);
  assert.equal(f.raw.options.optionalNamespaces.eip155.chains[0], "eip155:296");
  assert.equal(f.raw.initOptions.metadata.url, config.origin);
  assert.match(f.raw.initOptions.customStoragePrefix, /^neuron-/);
  f.approval.resolve(session());
  await connecting;
  assert.equal(f.registered.length, 1);
  assert.equal(displayed.at(-1), null);
  f.events.emit("session_update");
  await settle();
  assert.equal(f.removed.length, 1);
  assert.equal(f.raw.disconnects, 1); // disconnect must not recursively disconnect.
  await assert.rejects(
    f.registered[0].request({ method: "eth_accounts" }),
    /changed or disconnected/,
  );
});

test("cancelled pairing never registers a late approval and permits a subsequent attempt", async () => {
  const f = fixture(),
    abort = new AbortController(),
    displayed = [];
  const connecting = f.api.connectWalletConnect(
    config,
    (value) => displayed.push(value),
    abort.signal,
  );
  await f.requested;
  await assert.rejects(f.api.connectWalletConnect(config), /already opening/);
  abort.abort();
  await assert.rejects(connecting, /cancelled/);
  await assert.rejects(f.api.connectWalletConnect(config), /still settling/);
  assert.equal(displayed.at(-1), null);
  f.approval.resolve(session());
  await settle();
  assert.equal(f.registered.length, 0);
  assert.equal(f.raw.disconnects, 1);
  assert.equal(f.timers.size, 0);
  await f.api.connectWalletConnect(config);
  assert.equal(f.registered.length, 1, "the cancelled attempt releases the connection gate");
  assert.equal(
    f.counts().coreCount,
    1,
    "retries reuse the owned Core instead of retaining another global instance",
  );
  assert.equal(f.counts().initCount, 1);
  assert.equal(f.core.relayer.opens, 1);
});

test("pairing timeout returns control and prevents late registration", async () => {
  const f = fixture();
  const connecting = f.api.connectWalletConnect(config);
  await f.requested;
  f.fire(120_000);
  await assert.rejects(connecting, /timed out/);
  f.approval.resolve(session());
  await settle();
  assert.equal(f.registered.length, 0);
});

test("rejected or malformed pairing cannot remain selected", async () => {
  const rejected = fixture();
  const pending = rejected.api.connectWalletConnect(config);
  await rejected.requested;
  rejected.approval.reject(new Error("User rejected pairing"));
  await assert.rejects(pending, /User rejected/);
  assert.equal(rejected.registered.length, 0);
  const malformed = fixture();
  const invalid = malformed.api.connectWalletConnect(config);
  await malformed.requested;
  malformed.events.emit("display_uri", "https://untrusted.invalid");
  await assert.rejects(invalid, /invalid pairing URI/);
  malformed.approval.resolve(session());
  await settle();
  assert.equal(malformed.registered.length, 0);
});

test("disconnect removes selection before a stalled remote wallet and returns within the deadline", async () => {
  const f = fixture();
  const connecting = f.api.connectWalletConnect(config);
  await f.requested;
  f.approval.resolve(session());
  await connecting;
  f.raw.disconnect = () => new Promise(() => {});
  const disconnecting = f.api.disconnectWalletConnect();
  assert.equal(f.removed.length, 1);
  await settle();
  f.fire(2_000);
  await assert.rejects(disconnecting, /disconnection timed out/);
  assert.ok(f.core.heartbeat.stops > 0);
  assert.equal(f.core.relayer.closes, 1, "stalled disconnect still closes the relay transport");
  await assert.rejects(f.api.connectWalletConnect(config), /reload this page/);
  await assert.rejects(f.registered[0].request({ method: "eth_accounts" }), /disconnected/);
});

test("cancellation before URI cleans again when pairing creation finishes and never displays the late URI", async () => {
  const beforeURI = deferred(),
    f = fixture({ beforeURI }),
    abort = new AbortController(),
    displayed = [];
  const connecting = f.api.connectWalletConnect(
    config,
    (value) => displayed.push(value),
    abort.signal,
  );
  await f.requested;
  abort.abort();
  await assert.rejects(connecting, /cancelled/);
  await settle();
  const firstClose = f.core.relayer.closes;
  beforeURI.resolve();
  await settle();
  assert.ok(f.core.relayer.closes > firstClose);
  assert.deepEqual(displayed, [null]);
  f.approval.resolve(session());
  await settle();
  assert.equal(f.registered.length, 0);
  assert.equal(f.raw.session, undefined);
  assert.ok(f.core.heartbeat.stops > 0);
});

test("cancelled initialization cannot allocate a second Core and closes the eventual provider", async () => {
  const initialization = deferred(),
    f = fixture({ initialization }),
    abort = new AbortController();
  const connecting = f.api.connectWalletConnect(config, () => {}, abort.signal);
  await settle();
  abort.abort();
  await assert.rejects(connecting, /cancelled/);
  await assert.rejects(f.api.connectWalletConnect(config), /still settling/);
  initialization.resolve();
  await settle();
  assert.equal(f.counts().coreCount, 1);
  assert.equal(f.registered.length, 0);
  assert.ok(f.core.heartbeat.stops > 0);
  assert.ok(f.core.relayer.closes > 0);
});

test("foreign origin, mainnet, arbitrary RPC and invalid project configuration never initialize a provider", async () => {
  const f = fixture();
  for (const override of [
    { origin: "https://other.invalid" },
    { chainId: 295 },
    { rpcUrl: "https://other.invalid" },
    { projectId: "wrong" },
  ]) {
    await assert.rejects(f.api.connectWalletConnect({ ...config, ...override }), /configuration/);
  }
  assert.equal(f.raw.initOptions, null);
});
