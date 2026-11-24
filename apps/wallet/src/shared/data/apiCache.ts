// Tiered read cache for wallet API reads (per-IP 300/min budget).
//
// Memory alone dies on every full reload, and a reload is the most expensive
// wallet event (~15 requests cold). So reads persist one tier down:
//
//   memory (hot, per mount) → IndexedDB (Dexie, table `cache`: survives reload,
//   and for `session` rows only while the same tab lives) → same table with
//   tier `local` for public slow-moving data.
//
// `peekCached` stays synchronous, so the very first paint can show the previous
// balance: `hydrateCache()` warms memory from IndexedDB once at boot, before
// React renders.
//
// What NEVER goes in any tier: auth material (httpOnly cookies stay the only
// session carrier), secrets, private keys. Storage is readable by any script
// on this origin, so only display-grade data is persisted — and every row
// carries its own timestamp + the module's CACHE_VERSION, so stale rows
// and post-deploy shape changes self-expire instead of poisoning reads.
//
// SDK convention: failures come back as `{ statusCode }` objects, not throws.
// Those are never cached, so an error state can't stick for a whole TTL.
//
// Cross-tab: logout / account switch / network switch broadcast over a
// BroadcastChannel so a second tab drops the same keys. A tab that changed
// accounts in another tab falls back to a fresh read (fail-open to network,
// never to another account's rows).
//
// Network scoping: every key lives under the boot network mode, so a cached
// Mainnet read can never satisfy a Testnet one (or the reverse). Switching
// modes therefore KEEPS the other network's rows — each mode has its own.

import { readBootNetworkMode } from "../app/bootMode.ts";
import { pidDb, type CacheRow } from "./db.ts";

/** Mode this page load booted into — the cache's network namespace. */
const CACHE_NETWORK = readBootNetworkMode();

type Tier = "memory" | "session" | "local";

interface CachedOptions {
  /** Freshness window. Money reads use a short coalesce window (dedupes the
   * StrictMode double-fire); slow reads use a real TTL. */
  ttlMs: number;
  /** Where the entry may persist. Defaults to memory-only (current money). */
  tier?: Tier;
}

type Entry = { at: number; value: unknown; v: number };

/** Bump when a cached shape changes — old entries are ignored, not migrated. */
export const CACHE_VERSION = 2;
/** Key prefix for the mode this page load booted into. */
export const CACHE_PREFIX = `pid_cache_v${CACHE_VERSION}:${CACHE_NETWORK}:`;
/** Rows older than this are pruned on boot; TTL still decides freshness. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHANNEL = `pid_cache_v${CACHE_VERSION}`;

/** Namespaced key: the caller's name only ever addresses this network. */
const scoped = (key: string): string => CACHE_PREFIX + key;

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

const isErrorShaped = (v: unknown): boolean =>
  typeof v === "object" && v !== null && "statusCode" in (v as Record<string, unknown>);

// Per-tab id: `session` rows must die with the tab, and IndexedDB has no such
// lifetime. sessionStorage holds only this opaque id (not data) across reloads.
const TAB_KEY = "pid_tab";

function tabId(): string {
  if (typeof window === "undefined") return "ssr";
  try {
    const existing = window.sessionStorage.getItem(TAB_KEY);
    if (existing) return existing;
    const id = Math.random().toString(36).slice(2);
    window.sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch {
    return "no-tab";
  }
}

const TAB = tabId();

function rowFor(key: string, tier: Tier, value: unknown): CacheRow {
  return {
    key: scoped(key),
    at: Date.now(),
    v: CACHE_VERSION,
    value,
    tier: tier === "local" ? "local" : "session",
    tab: tier === "local" ? null : TAB,
  };
}

/** A row this tab may use: this network, this cache shape, this tab or local. */
function usable(row: CacheRow | undefined): row is CacheRow {
  return !!row && row.v === CACHE_VERSION && (row.tier === "local" || row.tab === TAB);
}

async function readRow(key: string): Promise<CacheRow | null> {
  try {
    const row = await pidDb()?.cache.get(scoped(key));
    return usable(row) ? row : null;
  } catch {
    return null;
  }
}

function writeRow(key: string, tier: Tier, value: unknown): void {
  if (tier === "memory") return;
  void pidDb()
    ?.cache.put(rowFor(key, tier, value))
    .catch(() => undefined);
}

function dropRow(key: string): void {
  void pidDb()
    ?.cache.delete(scoped(key))
    .catch(() => undefined);
}

function dropAllRows(): void {
  void pidDb()
    ?.cache.where("key").startsWith(CACHE_PREFIX).delete()
    .catch(() => undefined);
}

/** Warm memory from IndexedDB so `peekCached` can paint the first frame. */
export async function hydrateCache(): Promise<void> {
  try {
    const db = pidDb();
    if (!db) return;
    const rows = await db.cache.where("key").startsWith(CACHE_PREFIX).toArray();
    const cutoff = Date.now() - MAX_AGE_MS;
    const doomed: string[] = [];
    for (const row of rows) {
      if (!usable(row) || row.at < cutoff) doomed.push(row.key);
      else store.set(row.key, { at: row.at, value: row.value, v: row.v });
    }
    if (doomed.length > 0) await db.cache.bulkDelete(doomed);
  } catch {
    // No IndexedDB: memory-only cache, same behavior as a cold tab.
  }
}

/** Broadcast a drop to other tabs. */
function broadcastInvalidate(key: string | null): void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ key });
    channel.close();
  } catch {
    // No BroadcastChannel — same-tab behavior is unaffected.
  }
}

if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent<{ key: string | null }>) => {
    const key = e.data?.key;
    if (key === null) {
      store.clear();
      inflight.clear();
      dropAllRows();
    } else if (typeof key === "string") {
      const sk = scoped(key);
      store.delete(sk);
      inflight.delete(sk);
      dropRow(key);
    }
  };
}

export async function cachedRead<T>(key: string, ttlOrOpts: number | CachedOptions, fn: () => Promise<T>): Promise<T> {
  const opts: CachedOptions = typeof ttlOrOpts === "number" ? { ttlMs: ttlOrOpts } : ttlOrOpts;
  const tier = opts.tier ?? "memory";
  const sk = scoped(key);
  const hit = store.get(sk);
  if (hit && Date.now() - hit.at < opts.ttlMs) return hit.value as T;
  if (tier !== "memory") {
    const row = await readRow(key);
    if (row && Date.now() - row.at < opts.ttlMs) {
      store.set(sk, { at: row.at, value: row.value, v: row.v });
      return row.value as T;
    }
  }
  const pending = inflight.get(sk);
  if (pending) return pending as Promise<T>;
  const p = fn()
    .then((value) => {
      if (!isErrorShaped(value)) {
        const entry: Entry = { at: Date.now(), value, v: CACHE_VERSION };
        store.set(sk, entry);
        writeRow(key, tier, value);
      }
      return value;
    })
    .finally(() => inflight.delete(sk));
  inflight.set(sk, p);
  return p;
}

/**
 * Last cached value for THIS network, ignoring the TTL — paint the previous
 * balance instantly on reload/mode switch while the fresh read runs. Never
 * crosses networks (namespaced) and never returns another account's data
 * (logout/account switch calls clearApiCache()).
 */
export function peekCached<T>(key: string): T | null {
  const hit = store.get(scoped(key));
  return hit ? (hit.value as T) : null;
}

/** Drop every cached read: logout, account switch, network switch. */
export function clearApiCache(): void {
  store.clear();
  inflight.clear();
  dropAllRows();
  broadcastInvalidate(null);
}

/** Drop one cached read — call after a mutation so the list refetch is real. */
export function invalidate(key: string): void {
  store.delete(scoped(key));
  inflight.delete(scoped(key));
  dropRow(key);
  broadcastInvalidate(key);
}
