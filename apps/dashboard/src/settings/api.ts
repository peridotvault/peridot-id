/**
 * ANT-460 — typed client for the admin System Settings API.
 *
 * Consumes `v1/admin/settings/*` + `v1/admin/xp/backfill/*` (ANT-457 spec §5,
 * contract-first). Every route is Role.admin server-side (JwtAuthGuard +
 * AdminGuard); the dashboard only hides/disables — the server enforces.
 *
 * Backend: ANT-459 (Tyler). Until that lands, these calls fail and the page
 * renders the retryable API-unavailable state (spec G6) instead of a table.
 */
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../workspace/api";
import type { SettingValueType } from "./catalog";

const BASE = "/v1/admin/settings";

export interface SystemSetting {
  key: string;
  value: unknown;
  valueType: SettingValueType;
  description: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface SettingHistoryEntry {
  version: number;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  updatedBy: string;
  updatedAt: string;
}

export interface EffectiveIntake {
  effectiveIntake: boolean;
  breakdown: {
    suspendGlobal: boolean;
    suspendApp: boolean;
    source: "db" | "defaults-fallback";
  };
}

export class SettingVersionConflict extends Error {
  current: SystemSetting;
  constructor(message: string, current: SystemSetting) {
    super(message);
    this.name = "SettingVersionConflict";
    this.current = current;
  }
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export const systemSettings = {
  list: (c: PeridotClient, prefix?: string) =>
    c
      .get<{ settings: SystemSetting[] }>(`${BASE}${qs({ prefix: prefix || undefined })}`)
      .then((r) => unwrap(r, "Loading system settings")),

  get: (c: PeridotClient, key: string) =>
    c.get<SystemSetting>(`${BASE}/${encodeURIComponent(key)}`).then((r) => unwrap(r, "Loading setting")),

  put: async (
    c: PeridotClient,
    key: string,
    body: { value: unknown; reason: string; expectedVersion: number },
  ): Promise<SystemSetting> => {
    const res = await c.put<SystemSetting>(`${BASE}/${encodeURIComponent(key)}`, body);
    if (!res.ok) {
      const err = res.data as unknown as { error?: string; message?: string };
      if (err?.error === "version_conflict") {
        // Refetch current state so the conflict dialog shows actor/time/value.
        const current = await systemSettings.get(c, key);
        throw new SettingVersionConflict(err.message || "Changed by someone else.", current);
      }
      const detail = typeof err?.message === "string" && err.message ? err.message : "Saving setting";
      throw new Error(detail);
    }
    return unwrap(res, "Saving setting");
  },

  history: (c: PeridotClient, key: string, q?: { limit?: number; cursor?: string }) =>
    c
      .get<{ entries: SettingHistoryEntry[]; nextCursor: string | null }>(
        `${BASE}/${encodeURIComponent(key)}/history${qs({ limit: q?.limit, cursor: q?.cursor })}`,
      )
      .then((r) => unwrap(r, "Loading setting history")),

  effectiveIntake: (c: PeridotClient, appId?: string) =>
    c
      .get<EffectiveIntake>(`${BASE}/effective-intake${qs({ appId: appId || undefined })}`)
      .then((r) => unwrap(r, "Loading effective intake")),
};
