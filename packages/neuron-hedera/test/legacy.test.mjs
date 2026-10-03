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
  globalThis.fetch = async () =>
    new Response(JSON.stringify(Array(1001).fill({})), { status: 200 });
  try {
    await assert.rejects(listLegacyDevices(config), /exceeds 1000 device records/);
  } finally {
    globalThis.fetch = original;
  }
});

test("read-only throttling retries are bounded and retain one request deadline", async () => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { readOnlyJson } = await import("../dist/mirror.js");
  let replies = [],
    calls = 0;
  const server = createServer((request, response) => {
    assert.equal(request.method, "GET");
    const reply = replies[Math.min(calls++, replies.length - 1)];
    response.writeHead(reply.status, {
      "content-type": "application/json",
      ...(reply.after === undefined ? {} : { "retry-after": reply.after }),
    });
    if (reply.stall) {
      response.flushHeaders();
      response.write('{"ok":'); // Headers and partial body arrive; completion never does.
    } else response.end(reply.body ?? '{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/read`;
  const originalFetch = globalThis.fetch;
  let signals = [];
  globalThis.fetch = (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    signals.push(options.signal);
    return originalFetch(url, options);
  };
  try {
    replies = [{ status: 429, after: "0" }, { status: 503, after: "0" }, { status: 200 }];
    assert.deepEqual(await readOnlyJson(endpoint, "Fixture"), { ok: true });
    assert.equal(calls, 3);
    assert.equal(new Set(signals).size, 1);
    for (const reply of [
      { status: 404 },
      { status: 500 },
      { status: 429, after: "3" },
      { status: 503, after: "nonsense" },
      { status: 503, after: new Date(Date.now() + 60_000).toUTCString() },
    ]) {
      replies = [reply];
      calls = 0;
      await assert.rejects(readOnlyJson(endpoint, "Fixture"), /HTTP/);
      assert.equal(calls, 1, "permanent errors or long/invalid Retry-After must not be retried");
    }
    replies = [{ status: 429, after: "0" }];
    calls = 0;
    await assert.rejects(readOnlyJson(endpoint, "Fixture"), /HTTP 429/);
    assert.equal(calls, 3);
    replies = [{ status: 200, body: "bad json" }];
    calls = 0;
    await assert.rejects(readOnlyJson(endpoint, "Fixture"), SyntaxError);
    assert.equal(calls, 1, "bad data is not a transient status");
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => originalTimeout(100);
    try {
      replies = [
        { status: 429, after: "0" },
        { status: 200, stall: true },
      ];
      calls = 0;
      signals = [];
      await assert.rejects(readOnlyJson(endpoint, "Fixture"), (error) =>
        ["TimeoutError", "AbortError"].includes(error.name),
      );
      assert.equal(calls, 2);
      assert.equal(new Set(signals).size, 1, "body reading cannot start a fresh timeout");
      replies = [{ status: 429, after: "1" }, { status: 200 }];
      calls = 0;
      await assert.rejects(
        readOnlyJson(endpoint, "Fixture"),
        (error) => error.name === "TimeoutError",
      );
      assert.equal(calls, 1, "expiry during positive backoff must not issue another request");
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
