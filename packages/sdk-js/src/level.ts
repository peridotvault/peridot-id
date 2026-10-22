import type { ApiError, LevelSummary } from "@peridotvault/pid-types";

/** Minimal surface PeridotLevel needs — mirrors the pattern in wallet-client. */
interface ApiLike {
  get<T>(path: string): Promise<{ ok: boolean; data: T | ApiError }>;
}

/**
 * ANT-89 M3 — read-only Level helper.
 *
 * Fetches `GET /v1/users/{pid}/level` (level, total_xp, progress) for
 * integrators who CHOOSE to show it. Read-only: no XP amounts are accepted
 * or generated client-side — the server is the sole awarding authority.
 * Re-read instead of persisting (no XP duplication in app DBs).
 */
export class PeridotLevel {
  constructor(private client: ApiLike) {}

  /**
   * Get the authoritative level summary for a PID. Any authorized credential
   * works (session or machine token), including unverified apps — XP
   * permission gates event intake only, never reads. Unknown or deleted PIDs
   * resolve to a 404 `ApiError`.
   */
  async get(pid: string): Promise<LevelSummary | ApiError> {
    const res = await this.client.get<LevelSummary>(`/v1/users/${encodeURIComponent(pid)}/level`);
    return res.data;
  }
}
