// Tiered read cache for wallet API reads (per-IP 300/min budget).
//
// Memory alone dies on every full reload, and a reload is the most expensive
// wallet event (~15 requests cold). So reads persist one tier down:
//
//   memory (hot, per mount) → sessionStorage (warm, survives reload, dies
//   with the tab) → localStorage (cold, survives reloads + sessions, for
//   public slow-moving data only).
//
// What NEVER goes in any tier: auth material (httpOnly cookies stay the only
// session carrier), secrets, private keys. Storage is readable by any script
// on this origin, so only display-grade data is persisted — and every entry
// carries its own timestamp + the module's CACHE_VERSION, so stale entries
// and post-deploy shape changes self-expire instead of poisoning reads.
//
// SDK convention: failures come back as `{ statusCode }` objects, not throws.
// Those are never cached, so an error state can't stick for a whole TTL.
//
// Cross-tab: logout / account switch / network switch broadcast via the
// `storage` event so a second tab drops the same keys. A tab that changed
// accounts in another tab falls back to a fresh read (fail-open to network,
// never to another account's rows).
//
// Network scoping: every key lives under the boot network mode, so a cached
// Mainnet read can never satisfy a Testnet one (or the reverse). Switching
// modes therefore KEEPS the other network's entries — each mode has its own.

import { readBootNetworkMode } from "../app/bootMode.ts";

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
/** Storage-key prefix for the mode this page load booted into. */
export const CACHE_PREFIX = `pid_cache_v${CACHE_VERSION}:${CACHE_NETWORK}:`;
const INVALIDATE_EVENT = `pid_cache_v${CACHE_VERSION}:invalidate`;

/** Namespaced key: the caller's name only ever addresses this network. */
const scoped = (key: string): string => CACHE_PREFIX + key;

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

const isErrorShaped = (v: unknown): boolean =>
  typeof v === "object" && v !== null && "statusCode" in (v as Record<string, unknown>);

function storageFor(tier: Tier): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    if (tier === "session") return window.sessionStorage;
    if (tier === "local") return window.localStorage;
    return null;
  } catch {
    // Private mode / blocked storage — memory tier keeps working.
    return null;
  }
}

function readTier(key: string, tier: Tier, ttlMs: number): Entry | null {
  if (tier === "memory") return null;
  const storage = storageFor(tier);
  if (!storage) return null;
  try {
    const raw = storage.getItem(scoped(key));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry;
    if (typeof entry !== "object" || entry === null || entry.v !== CACHE_VERSION) return null;
    if (typeof entry.at !== "number" || Date.now() - entry.at >= ttlMs) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeTier(key: string, tier: Tier, value: unknown): void {
  if (tier === "memory") return;
  const storage = storageFor(tier);
  if (!storage) return;
  try {
    storage.setItem(scoped(key), JSON.stringify({ at: Date.now(), value, v: CACHE_VERSION }));
  } catch {
    // Quota full or blocked — the memory tier already holds this read.
  }
}

function dropTier(key: string, tier: Tier): void {
  if (tier === "memory") return;
  try {
    storageFor(tier)?.removeItem(scoped(key));
  } catch {
    // Best-effort only.
  }
}

function dropAllTiers(): void {
  for (const tier of ["session", "local"] as const) {
    const storage = storageFor(tier);
    if (!storage) continue;
    try {
      const doomed: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(CACHE_PREFIX)) doomed.push(k);
      }
      doomed.forEach((k) => storage.removeItem(k));
    } catch {
      // Best-effort only.
    }
  }
}

/** Broadcast a drop to other tabs (same origin `storage` event). */
function broadcastInvalidate(key: string | null): void {
  const storage = storageFor("local");
  if (!storage) return;
  try {
    storage.setItem(INVALIDATE_EVENT, JSON.stringify({ key, at: Date.now() }));
    storage.removeItem(INVALIDATE_EVENT);
  } catch {
    // No cross-tab channel — same-tab behavior is unaffected.
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== INVALIDATE_EVENT || !e.newValue) return;
    try {
      const { key } = JSON.parse(e.newValue) as { key: string | null };
      if (key === null) {
        store.clear();
        dropAllTiers();
      } else {
        store.delete(scoped(key));
        dropTier(key, "session");
        dropTier(key, "local");
        inflight.delete(scoped(key));
      }
    } catch {
      // Malformed ping — ignore, worst case a ≤TTL stale read.
    }
  });
}

export async function cachedRead<T>(key: string, ttlOrOpts: number | CachedOptions, fn: () => Promise<T>): Promise<T> {
  const opts: CachedOptions = typeof ttlOrOpts === "number" ? { ttlMs: ttlOrOpts } : ttlOrOpts;
  const tier = opts.tier ?? "memory";
  const sk = scoped(key);
  const hit = store.get(sk);
  if (hit && Date.now() - hit.at < opts.ttlMs) return hit.value as T;
  if (tier !== "memory") {
    const persisted = readTier(key, tier, opts.ttlMs);
    if (persisted) {
      store.set(sk, persisted);
      return persisted.value as T;
    }
  }
  const pending = inflight.get(sk);
  if (pending) return pending as Promise<T>;
  const p = fn()
    .then((value) => {
      if (!isErrorShaped(value)) {
        const entry: Entry = { at: Date.now(), value, v: CACHE_VERSION };
        store.set(sk, entry);
        writeTier(key, tier, value);
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
  if (hit) return hit.value as T;
  for (const tier of ["session", "local"] as const) {
    const persisted = readTier(key, tier, Number.POSITIVE_INFINITY);
    if (persisted) {
      store.set(scoped(key), persisted);
      return persisted.value as T;
    }
  }
  return null;
}

/** Drop every cached read: logout, account switch, network switch. */
export function clearApiCache(): void {
  store.clear();
  inflight.clear();
  dropAllTiers();
  broadcastInvalidate(null);
}

/** Drop one cached read — call after a mutation so the list refetch is real. */
export function invalidate(key: string): void {
  store.delete(scoped(key));
  inflight.delete(scoped(key));
  dropTier(key, "session");
  dropTier(key, "local");
  broadcastInvalidate(key);
}
