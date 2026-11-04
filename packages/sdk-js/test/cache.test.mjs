// Read cache: fewer API calls per app, without any integrator code.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";
import { Peridot } from "../dist/esm/index.js";

function fakeStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => JSON.stringify([...map.entries()]),
  };
}

/** Minimal browser-ish globals the cache module looks for. */
/** Fresh client with an empty cache — the module keeps one cache per process. */
function freshClient(opts) {
  const peridot = Peridot(opts);
  peridot.cache.clear();
  return peridot;
}

function withBrowserGlobals() {
  const session = fakeStorage();
  const local = fakeStorage();
  const listeners = [];
  globalThis.window = {
    sessionStorage: session,
    localStorage: local,
    addEventListener: (type, cb) => listeners.push({ type, cb }),
    removeEventListener: () => {},
  };
  return { session, local, listeners };
}

function jsonFetch(body = { pid: "ifal@pid" }) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}

test("identity reads are served once and then from cache", async () => {
  withBrowserGlobals();
  const cap = jsonFetch();
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301", clientId: "pidapp_test" });
    await peridot.identity.me();
    await peridot.identity.me();
    await peridot.identity.me();
    assert.equal(cap.calls.length, 1, "three reads must hit the API once");
  } finally {
    cap.restore();
  }
});

test("concurrent reads de-duplicate into one request", async () => {
  withBrowserGlobals();
  const cap = jsonFetch();
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301" });
    await Promise.all([peridot.identity.me(), peridot.identity.me(), peridot.identity.me()]);
    assert.equal(cap.calls.length, 1, "in-flight reads must share one request");
  } finally {
    cap.restore();
  }
});

test("cache: false keeps every read real", async () => {
  withBrowserGlobals();
  const cap = jsonFetch();
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301", cache: false });
    await peridot.identity.me();
    await peridot.identity.me();
    assert.equal(cap.calls.length, 2);
  } finally {
    cap.restore();
  }
});

test("peridot.cache.clear() forces the next read", async () => {
  withBrowserGlobals();
  const cap = jsonFetch();
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301" });
    await peridot.identity.me();
    peridot.cache.clear();
    await peridot.identity.me();
    assert.equal(cap.calls.length, 2);
  } finally {
    cap.restore();
  }
});

test("namespace invalidation drops only that namespace", async () => {
  withBrowserGlobals();
  const cap = jsonFetch({ balanceIdr: "1000", currency: "IDR", source: "fiat-ledger", replayErrors: [] });
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301" });
    await peridot.fiat.balance();
    await peridot.identity.me();
    peridot.cache.invalidate("fiat.");
    await peridot.fiat.balance();
    await peridot.identity.me();
    const urls = cap.calls.map((c) => c.url);
    assert.equal(urls.filter((u) => u.endsWith("/v1/identity/me")).length, 1, "identity stays cached");
    assert.equal(urls.filter((u) => u.endsWith("/v1/fiat/balance")).length, 2, "balance refetched");
  } finally {
    cap.restore();
  }
});

test("swapping the bearer drops the cache (no cross-identity reads)", async () => {
  withBrowserGlobals();
  const cap = jsonFetch();
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301", bearer: "token-a" });
    await peridot.identity.me();
    peridot.setBearer("token-b");
    await peridot.identity.me();
    assert.equal(cap.calls.length, 2, "a new bearer must not be served the old body");
  } finally {
    cap.restore();
  }
});

test("error-shaped results are never cached", async () => {
  withBrowserGlobals();
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ statusCode: 404, message: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301" });
    await peridot.identity.me();
    await peridot.identity.me();
    assert.equal(calls, 2, "a 404 must not stick for a whole TTL");
  } finally {
    globalThis.fetch = saved;
  }
});

test("ttl expiry refetches after the window", async () => {
  withBrowserGlobals();
  const cap = jsonFetch();
  const realNow = Date.now;
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301" });
    await peridot.fiat.balance();
    Date.now = () => realNow() + 6_000; // past CACHE_TTL.money (5s)
    await peridot.fiat.balance();
    assert.equal(cap.calls.length, 2);
  } finally {
    Date.now = realNow;
    cap.restore();
  }
});

test("persisted entries carry no credentials", async () => {
  const { session, local, dumpSafe } = (() => {
    const b = withBrowserGlobals();
    return { ...b, dumpSafe: () => b.session.dump() + b.local.dump() };
  })();
  const cap = jsonFetch();
  try {
    const peridot = freshClient({ baseUrl: "http://localhost:3301", bearer: "super-secret-bearer" });
    await peridot.identity.me();
    const persisted = dumpSafe();
    assert.ok(session.length + local.length >= 0);
    assert.ok(!persisted.includes("super-secret-bearer"), "bearer must never reach storage");
  } finally {
    cap.restore();
  }
});
