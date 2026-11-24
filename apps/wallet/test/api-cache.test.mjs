// Request-budget guard: the wallet must not refetch slow-changing reads on
// every Home mount (per-IP 300/min 429s).
// Run: `node --test test/` from apps/wallet.
import "fake-indexeddb/auto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_PREFIX,
  CACHE_VERSION,
  cachedRead,
  clearApiCache,
  hydrateCache,
  invalidate,
  peekCached,
} from "../src/shared/data/apiCache.ts";
import { hydratePrefs, pidDb, prefStorage } from "../src/shared/data/db.ts";

const row = (key) => pidDb().cache.get(CACHE_PREFIX + key);
const seed = (key, value, extra = {}) =>
  pidDb().cache.put({
    key: CACHE_PREFIX + key,
    at: Date.now(),
    v: CACHE_VERSION,
    value,
    tier: "session",
    tab: "ssr",
    ...extra,
  });

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

  it("persists tiered reads in IndexedDB (Dexie)", async () => {
    let calls = 0;
    const fn = async () => ({ n: ++calls });
    // Write-through: the read lands in the `cache` table…
    assert.deepEqual(await cachedRead("t-tier", { ttlMs: 60_000, tier: "session" }, fn), { n: 1 });
    const written = await row("t-tier");
    assert.deepEqual(written?.value, { n: 1 });
    assert.equal(written?.tier, "session");
    // …and a seeded row is served without calling fn again.
    await seed("t-seed", { n: 7 });
    assert.deepEqual(await cachedRead("t-seed", { ttlMs: 60_000, tier: "session" }, fn), { n: 7 });
    assert.equal(calls, 1);
    // A local-tier read is marked as such (survives more than one tab).
    await cachedRead("t-local", { ttlMs: 60_000, tier: "local" }, fn);
    assert.equal((await row("t-local"))?.tier, "local");
    invalidate("t-tier");
    invalidate("t-seed");
    assert.equal(await row("t-tier"), undefined);
    // Dropped row ⇒ the next read goes to the network again (call #3: the
    // t-tier miss, t-seed's hit and t-local's write came before it).
    assert.deepEqual(await cachedRead("t-tier", { ttlMs: 60_000, tier: "session" }, fn), { n: 3 });
  });

  it("hydrates a stale value for the current network (paints before refresh)", async () => {
    // Old enough to be stale for any TTL, young enough to survive the boot prune.
    await seed("t-stale", { balanceIdr: "123" }, { at: Date.now() - 60_000 });
    await hydrateCache();
    assert.deepEqual(peekCached("t-stale"), { balanceIdr: "123" });
    // Another network's row is never visible (keys are mode-namespaced).
    await pidDb().cache.put({
      key: CACHE_PREFIX.replace(/:mainnet:/, ":testnet:") + "t-other",
      at: Date.now(),
      v: CACHE_VERSION,
      value: "leak",
      tier: "local",
      tab: null,
    });
    await hydrateCache();
    assert.equal(peekCached("t-other"), null);
    invalidate("t-stale");
  });

  it("drops rows written by another cache version", async () => {
    await seed("t-old", 1, { v: 9999 });
    let calls = 0;
    assert.equal(await cachedRead("t-old", { ttlMs: 60_000, tier: "session" }, async () => ++calls), 1);
    assert.equal(calls, 1);
    invalidate("t-old");
  });
});

describe("prefs (Dexie mirror)", () => {
  it("flushes writes to IndexedDB and hydrates them back", async () => {
    const store = prefStorage();
    store.setItem("pid:sound", JSON.stringify({ pack: "zen", enabled: false }));
    // The mirror answers synchronously (first render), the table write follows.
    assert.equal(JSON.parse(store.getItem("pid:sound")).enabled, false);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await pidDb().prefs.get("pid:sound"))?.value, store.getItem("pid:sound"));
    store.removeItem("pid:sound");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(await pidDb().prefs.get("pid:sound"), undefined);
  });

  it("hydrates stored prefs for the next boot", async () => {
    await pidDb().prefs.put({ key: "pid:probe", value: "1" });
    await hydratePrefs();
    assert.equal(prefStorage().getItem("pid:probe"), "1");
    await pidDb().prefs.delete("pid:probe");
  });
});
