// On-chain activity cache (localStorage-backed), scoped per smart-account address.
// `peridot.wallet.history()` reads the live Solana chain for the smart-account address +
// token ATAs, parses the transactions into WalletTransaction rows, and persists them under
// the owner smart account so account A's view never leaks into account B's (a send for A is
// a receive for B, and they share the same on-chain signature). Folks can clear the key to
// force a full re-sync.

import type { WalletTransaction } from "@peridotvault/pid-types";

export interface HistoryStore {
  get(scope: string): Promise<WalletTransaction[] | null>;
  set(scope: string, rows: WalletTransaction[]): Promise<void>;
}

const KEY_PREFIX = "peridot.wallet.history";

function storageKey(scope: string): string {
  return `${KEY_PREFIX}.${scope}`;
}

/** localStorage cache with an in-memory fallback (SSR / no DOM). */
export class LocalHistoryStore implements HistoryStore {
  private readonly memory = new Map<string, string>();
  private get storage(): Storage | null {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch {
      return null;
    }
  }

  async get(scope: string): Promise<WalletTransaction[] | null> {
    const key = storageKey(scope);
    const raw = this.storage?.getItem(key) ?? this.memory.get(key) ?? null;
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as WalletTransaction[];
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async set(scope: string, rows: WalletTransaction[]): Promise<void> {
    const key = storageKey(scope);
    const raw = JSON.stringify(rows);
    if (this.storage) {
      try {
        this.storage.setItem(key, raw);
      } catch {
        // quota exceeded — fall back to memory only
      }
    }
    this.memory.set(key, raw);
  }
}