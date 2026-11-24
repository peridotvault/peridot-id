import Dexie, { type Table } from "dexie";

// One IndexedDB database for everything the wallet keeps across reloads: the
// API read cache (balances, profile, chains, history) and the preferences that
// can wait for a boot-time hydration.
//
// NOT here (and why): values read before the first paint or by a module at
// import time — the network mode picks the API origin in `app/config.ts`, and
// uisfx's player takes a synchronous storage adapter. IndexedDB is async, so
// those three stay in localStorage (see the note in shared/data/networkMode.ts).
export interface CacheRow {
  /** Network-scoped cache key (same shape the memory tier uses). */
  key: string;
  /** Write time (ms) — TTL is applied by the caller. */
  at: number;
  /** Cache shape version; old rows are ignored, never migrated. */
  v: number;
  value: unknown;
  /** `local` survives everything; `session` only belongs to the writing tab. */
  tier: "session" | "local";
  /** Tab that wrote a session row (null for local rows). */
  tab: string | null;
}

export interface PrefRow {
  key: string;
  value: unknown;
}

class PidDatabase extends Dexie {
  cache!: Table<CacheRow, string>;
  prefs!: Table<PrefRow, string>;

  constructor() {
    super("pid");
    this.version(1).stores({ cache: "key, at", prefs: "key" });
  }
}

let db: PidDatabase | null = null;
let failed = false;

/** The database, or null where IndexedDB is missing/blocked (SSR, private mode). */
export function pidDb(): PidDatabase | null {
  if (failed || typeof indexedDB === "undefined") return null;
  if (!db) {
    try {
      db = new PidDatabase();
    } catch {
      failed = true;
      return null;
    }
  }
  return db;
}

/** Read one preference row (null when the database is unavailable). */
export async function readPref<T>(key: string): Promise<T | null> {
  try {
    const row = await pidDb()?.prefs.get(key);
    return (row?.value as T) ?? null;
  } catch {
    return null;
  }
}

/** Write one preference row; failures are non-fatal (memory state stands). */
export async function writePref(key: string, value: unknown): Promise<void> {
  try {
    await pidDb()?.prefs.put({ key, value });
  } catch {
    // Blocked or over quota — the caller keeps its in-memory value.
  }
}

/** Delete one preference row. */
export async function removePref(key: string): Promise<void> {
  try {
    await pidDb()?.prefs.delete(key);
  } catch {
    // Non-fatal, same as writePref.
  }
}

// Synchronous, hydrate-once view of the `prefs` table. Preferences that must be
// readable on the first render (sound, chain selection) read from this mirror;
// writes land in the mirror immediately and are flushed to IndexedDB after.
// `hydratePrefs()` must run before the app renders.
const mirror = new Map<string, string>();

/** Warm the mirror from IndexedDB (boot gate, before render). */
export async function hydratePrefs(): Promise<void> {
  try {
    const rows = (await pidDb()?.prefs.toArray()) ?? [];
    for (const row of rows) if (typeof row.value === "string") mirror.set(row.key, row.value);
  } catch {
    // No IndexedDB: the mirror starts empty, same behavior as a fresh browser.
  }
}

/** Storage-shaped view over the mirror — a drop-in where a `Storage` is expected. */
export function prefStorage(): Storage {
  return {
    getItem: (key) => mirror.get(key) ?? null,
    setItem: (key, value) => {
      mirror.set(key, String(value));
      void writePref(key, String(value));
    },
    removeItem: (key) => {
      mirror.delete(key);
      void removePref(key);
    },
    clear: () => {
      for (const key of [...mirror.keys()]) {
        mirror.delete(key);
        void removePref(key);
      }
    },
    key: (index) => [...mirror.keys()][index] ?? null,
    get length() {
      return mirror.size;
    },
  };
}
