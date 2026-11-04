// Read-through cache for SDK GETs.
//
// Every integrator gets fewer API calls without writing cache code: reads go
// through `cachedRead`, mutations call `invalidateCache`, and the client clears
// everything when the identity changes (bearer swap, logout, account switch).
//
// Tiers: memory (hot) → sessionStorage (survives reload, dies with the tab) →
// localStorage (opt-in). Persisted entries are per-origin by platform
// definition, so nothing crosses from one app's origin to another's.
//
// What NEVER goes in any tier: bearers, tokens, secrets, signing material.
// Storage is readable by any script on the origin, so only display-grade reads
// are persisted, and error-shaped results are never cached.

export type CacheTier = "memory" | "session" | "local";

export interface CacheConfig {
  /** Defaults to true. `new Peridot({ cache: false })` disables it entirely. */
  enabled?: boolean;
  /** Default persistence tier. Defaults to `session`. */
  tier?: CacheTier;
}

/** Freshness windows per data class — the only place TTLs live. */
export const CACHE_TTL = {
  /** Money moves; a short coalesce window hides the StrictMode double-read. */
  money: 5_000,
  /** Session/identity-scoped reads that change on user action. */
  session: 60_000,
  /** App-scoped auth reads (accounts, sessions, grants). */
  auth: 30_000,
  /** Registries and fee policy — slow-moving configuration. */
  static: 600_000,
} as const;

/** Bump when a cached shape changes — old entries are ignored, not migrated. */
const CACHE_VERSION = 1;
const PREFIX = `pid_sdk_cache_v${CACHE_VERSION}:`;
const INVALIDATE_EVENT = `${PREFIX}invalidate`;

interface Entry {
  at: number;
  value: unknown;
  v: number;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

let enabled = true;
let defaultTier: CacheTier = "session";

const isErrorShaped = (v: unknown): boolean =>
  typeof v === "object" && v !== null && "statusCode" in (v as Record<string, unknown>);

function storageFor(tier: CacheTier): Storage | null {
  if (tier === "memory" || typeof window === "undefined") return null;
  try {
    return tier === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    // Private mode / blocked storage — the memory tier keeps working.
    return null;
  }
}

function readTier(key: string, tier: CacheTier, ttlMs: number): Entry | null {
  const storage = storageFor(tier);
  if (!storage) return null;
  try {
    const raw = storage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry;
    if (typeof entry !== "object" || entry === null || entry.v !== CACHE_VERSION) return null;
    if (typeof entry.at !== "number" || Date.now() - entry.at >= ttlMs) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeTier(key: string, tier: CacheTier, value: unknown): void {
  const storage = storageFor(tier);
  if (!storage) return;
  try {
    storage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value, v: CACHE_VERSION }));
  } catch {
    // Quota full or blocked — the memory tier already holds this read.
  }
}

function dropPersisted(matcher: (key: string) => boolean): void {
  for (const tier of ["session", "local"] as const) {
    const storage = storageFor(tier);
    if (!storage) continue;
    try {
      const doomed: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const raw = storage.key(i);
        if (!raw || !raw.startsWith(PREFIX) || raw === INVALIDATE_EVENT) continue;
        if (matcher(raw.slice(PREFIX.length))) doomed.push(raw);
      }
      for (const raw of doomed) storage.removeItem(raw);
    } catch {
      // Best-effort only.
    }
  }
}

/** Broadcast a drop to other tabs on the same origin (`storage` event). */
function broadcast(matcher: string | null): void {
  const storage = storageFor("local");
  if (!storage) return;
  try {
    storage.setItem(INVALIDATE_EVENT, JSON.stringify({ key: matcher, at: Date.now() }));
    storage.removeItem(INVALIDATE_EVENT);
  } catch {
    // No cross-tab channel — same-tab behaviour is unaffected.
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== INVALIDATE_EVENT || !e.newValue) return;
    try {
      const { key } = JSON.parse(e.newValue) as { key: string | null };
      const matches = (k: string): boolean => key === null || k === key || k.startsWith(key);
      for (const k of [...store.keys()]) if (matches(k)) store.delete(k);
      for (const k of [...inflight.keys()]) if (matches(k)) inflight.delete(k);
      dropPersisted(matches);
    } catch {
      // Malformed ping — ignore; worst case a read is stale by one TTL.
    }
  });
}

/** Apply `new Peridot({ cache })`. Idempotent; a disabled cache clears memory. */
export function configureCache(config?: CacheConfig | false): void {
  if (config === false) {
    enabled = false;
    clearCache();
    return;
  }
  enabled = config?.enabled !== false;
  defaultTier = config?.tier ?? "session";
  if (!enabled) clearCache();
}

/** True when reads are served from the cache (default). */
export function cacheEnabled(): boolean {
  return enabled;
}

/**
 * Read `key`, serving it from cache while fresh and de-duplicating concurrent
 * callers. `tier` overrides the configured persistence (money reads stay in
 * memory so a transfer can never be served from disk).
 */
export async function cachedRead<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  tier: CacheTier = defaultTier,
): Promise<T> {
  if (!enabled) return fn();
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  if (tier !== "memory") {
    const persisted = readTier(key, tier, ttlMs);
    if (persisted) {
      store.set(key, persisted);
      return persisted.value as T;
    }
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = fn()
    .then((value) => {
      if (!isErrorShaped(value)) {
        const entry: Entry = { at: Date.now(), value, v: CACHE_VERSION };
        store.set(key, entry);
        writeTier(key, tier, value);
      }
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Drop one key or a whole namespace (`invalidateCache("fiat.")` drops every
 * `fiat.*` read). Call after a mutation so the next read is real.
 */
export function invalidateCache(match: string): void {
  const matches = (k: string): boolean => k === match || k.startsWith(match);
  for (const k of [...store.keys()]) if (matches(k)) store.delete(k);
  for (const k of [...inflight.keys()]) if (matches(k)) inflight.delete(k);
  dropPersisted(matches);
  broadcast(match);
}

/** Drop everything: login, logout, bearer swap, account or network switch. */
export function clearCache(): void {
  store.clear();
  inflight.clear();
  dropPersisted(() => true);
  broadcast(null);
}
