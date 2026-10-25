// Request-budget guard: the wallet must not refetch slow-changing reads on
// every Home mount (per-IP 100/min 429s).
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cachedRead, clearApiCache, invalidate } from "../src/shared/data/apiCache.ts";

describe("cachedRead", () => {
  it("serves the second call from cache inside the TTL", async () => {
    let calls = 0;
    const fn = async () => ++calls;
    assert.equal(await cachedRead("t-hit", 50, fn), 1);
    assert.equal(await cachedRead("t-hit", 50, fn), 1);
    assert.equal(calls, 1);
  });

  it("dedupes concurrent calls into one request", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return "v";
    };
    const [a, b] = await Promise.all([cachedRead("t-inflight", 50, fn), cachedRead("t-inflight", 50, fn)]);
    assert.deepEqual([a, b], ["v", "v"]);
    assert.equal(calls, 1);
  });

  it("refetches once the TTL is over", async () => {
    let calls = 0;
    const fn = async () => ++calls;
    await cachedRead("t-expiry", 5, fn);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await cachedRead("t-expiry", 5, fn), 2);
  });

  it("never caches an SDK error shape", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { statusCode: 401 };
    };
    await cachedRead("t-error", 50, fn);
    await cachedRead("t-error", 50, fn);
    assert.equal(calls, 2);
  });

  it("clearApiCache forces a refetch (logout / account switch)", async () => {
    let calls = 0;
    const fn = async () => ++calls;
    await cachedRead("t-clear", 60_000, fn);
    clearApiCache();
    assert.equal(await cachedRead("t-clear", 60_000, fn), 2);
  });

  it("invalidate drops one key only (post-mutation refresh)", async () => {
    let a = 0;
    let b = 0;
    await cachedRead("t-inv-a", 60_000, async () => ++a);
    await cachedRead("t-inv-b", 60_000, async () => ++b);
    invalidate("t-inv-a");
    assert.equal(await cachedRead("t-inv-a", 60_000, async () => ++a), 2);
    assert.equal(await cachedRead("t-inv-b", 60_000, async () => ++b), 1);
  });

  it("supports the options form with tiers (session/local persist reads)", async () => {
    // node has no DOM: a minimal window stub exercises the persistence paths.
    // The module reads `window` lazily, so installing it now still works.
    const memStore = () => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => void m.set(String(k), String(v)),
        removeItem: (k) => void m.delete(k),
        key: (i) => [...m.keys()][i] ?? null,
        get length() {
          return m.size;
        },
      };
    };
    globalThis.window = { sessionStorage: memStore(), localStorage: memStore(), addEventListener: () => {} };

    let calls = 0;
    const fn = async () => ({ n: ++calls });
    // Write-through: the read lands in storage…
    assert.deepEqual(await cachedRead("t-tier", { ttlMs: 60_000, tier: "session" }, fn), { n: 1 });
    assert.ok(globalThis.window.sessionStorage.getItem("pid_cache_v1:t-tier"));
    // …and a pre-seeded storage entry is served without calling fn.
    globalThis.window.sessionStorage.setItem(
      "pid_cache_v1:t-seed",
      JSON.stringify({ at: Date.now(), value: { n: 7 }, v: 1 }),
    );
    assert.deepEqual(await cachedRead("t-seed", { ttlMs: 60_000, tier: "session" }, fn), { n: 7 });
    assert.equal(calls, 1);
    invalidate("t-tier");
    invalidate("t-seed");
    assert.deepEqual(await cachedRead("t-tier", { ttlMs: 60_000, tier: "session" }, fn), { n: 2 });
    // local tier works the same
    await cachedRead("t-local", { ttlMs: 60_000, tier: "local" }, fn);
    assert.ok(globalThis.window.localStorage.getItem("pid_cache_v1:t-local"));
    invalidate("t-local");
    clearApiCache();
  });

  it("ignores entries written by another cache version", async () => {
    globalThis.window.sessionStorage.setItem(
      "pid_cache_v1:t-old",
      JSON.stringify({ at: Date.now(), value: 1, v: 9999 }),
    );
    let calls = 0;
    assert.equal(await cachedRead("t-old", { ttlMs: 60_000, tier: "session" }, async () => ++calls), 1);
    assert.equal(calls, 1);
    invalidate("t-old");
  });
});
