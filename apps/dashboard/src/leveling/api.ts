/**
 * ANT-89 M2 — typed client for the admin experience API.
 *
 * Consumes `v1/admin/experience/*` (ExperienceAdminController, ANT-436) plus
 * the existing `v1/admin/apps` verify/list endpoints for the Applications
 * section. Every route is Role.admin server-side (JwtAuthGuard + AdminGuard);
 * the dashboard only hides/disables — the server enforces.
 *
 * Snake_case wire shapes below match the backend service returns verbatim
 * (Prisma rows serialize BigInt as decimal strings).
 */
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { unwrap } from "../workspace/api";

const BASE = "/v1/admin/experience";

export interface PolicyVersion {
  id: string;
  version: number;
  formula: { base: number; exponent: number; rounding: string };
  maxLevel: number | null;
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
  supersededAt: string | null;
  active: boolean;
  thresholdCount: number;
}

export interface PolicyPreview {
  policyId: string;
  version: number;
  activeVersion: number | null;
  thresholdCount: number;
  thresholdDiff: { level: number; draftXp: number; activeXp: number | null; delta: number | null }[];
  userImpact: { evaluated: number; truncated: boolean; leveledUp: number; leveledDown: number; unchanged: number };
}

export interface XpTask {
  id: string;
  key: string;
  name: string;
  description: string | null;
  xpReward: number;
  recurring: string;
  lifetimeLimit: number | null;
  dailyLimit: number | null;
  weeklyLimit: number | null;
  monthlyLimit: number | null;
  cooldownSecs: number | null;
  availableFrom: string | null;
  availableUntil: string | null;
  status: string;
  verificationType: string;
  verificationChecker: string | null;
  scopeAppId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  pid: string;
  deltaXp: string;
  balanceAfter: string;
  levelAfter: number;
  kind: string;
  taskId: string | null;
  eventId: string | null;
  appId: string | null;
  reason: string | null;
  actorAdminId: string | null;
  policyVersionId: string;
  createdAt: string;
}

export interface SuspiciousRow {
  id: string;
  pid: string | null;
  appId: string | null;
  signal: string;
  detail: unknown;
  reviewed: boolean;
  createdAt: string;
}

export interface Overview {
  totalXpDistributed: string;
  totalUsers: number;
  levelDistribution: { level: number; users: number }[];
  recentActivity: LedgerEntry[];
  unreviewedSuspicious: number;
}

export interface Page<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Admin-visible app row (PidApp minus secrets) for the Applications section. */
export interface XpApp {
  id: string;
  clientId: string;
  ownerPid: string;
  name: string;
  isActive: boolean;
  isVerified: boolean;
  xpEnabled: boolean;
  approvedEventTypes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface GrantEnvelope {
  confirmedBy?: string;
  reason?: string;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export const xpAdmin = {
  overview: (c: PeridotClient) => c.get<Overview>(`${BASE}/overview`).then((r) => unwrap(r, "Loading overview")),

  listPolicies: (c: PeridotClient) =>
    c.get<PolicyVersion[]>(`${BASE}/policies`).then((r) => unwrap(r, "Loading policies")),

  createPolicy: (c: PeridotClient, body: { base?: number; exponent?: number; maxLevel?: number }) =>
    c.post<PolicyVersion>(`${BASE}/policies`, body).then((r) => unwrap(r, "Drafting policy")),

  materializePolicy: (c: PeridotClient, id: string, overrides?: Record<string, number>) =>
    c
      .post<{ policyId: string; version: number; thresholdCount: number }>(
        `${BASE}/policies/${id}/materialize`,
        { overrides },
      )
      .then((r) => unwrap(r, "Materializing thresholds")),

  previewPolicy: (c: PeridotClient, id: string) =>
    c.get<PolicyPreview>(`${BASE}/policies/${id}/preview`).then((r) => unwrap(r, "Loading impact preview")),

  activatePolicy: (c: PeridotClient, id: string, body: GrantEnvelope) =>
    c.post<PolicyVersion>(`${BASE}/policies/${id}/activate`, body).then((r) => unwrap(r, "Activating policy")),

  listTasks: (c: PeridotClient, q?: { status?: string; limit?: number; offset?: number }) =>
    c
      .get<Page<XpTask>>(`${BASE}/tasks${qs({ status: q?.status, limit: q?.limit, offset: q?.offset })}`)
      .then((r) => unwrap(r, "Loading tasks")),

  getTask: (c: PeridotClient, id: string) =>
    c.get<XpTask>(`${BASE}/tasks/${id}`).then((r) => unwrap(r, "Loading task")),

  createTask: (c: PeridotClient, body: Record<string, unknown>) =>
    c.post<XpTask>(`${BASE}/tasks`, body).then((r) => unwrap(r, "Creating task")),

  updateTask: (c: PeridotClient, id: string, body: Record<string, unknown>) =>
    c.patch<XpTask>(`${BASE}/tasks/${id}`, body).then((r) => unwrap(r, "Updating task")),

  setXpPermission: (
    c: PeridotClient,
    appId: string,
    body: { xpEnabled: boolean; approvedEventTypes: string[] } & GrantEnvelope,
  ) =>
    c
      .put<{ app: XpApp; selfGrantAlert: boolean }>(`${BASE}/apps/${appId}/xp-permission`, body)
      .then((r) => unwrap(r, "Saving XP permission")),

  upsertQuota: (
    c: PeridotClient,
    appId: string,
    body: { dailyCap?: number | null; weeklyCap?: number | null; monthlyCap?: number | null } & GrantEnvelope,
  ) =>
    c
      .put<{ quota: Record<string, unknown>; selfGrantAlert: boolean }>(`${BASE}/apps/${appId}/quota`, body)
      .then((r) => unwrap(r, "Saving quota")),

  upsertOrgQuota: (
    c: PeridotClient,
    ownerPid: string,
    body: { dailyCap?: number | null; weeklyCap?: number | null; monthlyCap?: number | null } & GrantEnvelope,
  ) =>
    c
      .put<{ quota: Record<string, unknown> }>(
        `${BASE}/org-quotas/${encodeURIComponent(ownerPid)}`,
        body,
      )
      .then((r) => unwrap(r, "Saving org quota")),

  suspendApp: (c: PeridotClient, appId: string, body: { suspended: boolean; suspendReason?: string; reason?: string }) =>
    c
      .patch<{ quota: Record<string, unknown>; selfGrantAlert: boolean }>(`${BASE}/apps/${appId}/suspend`, body)
      .then((r) => unwrap(r, "Updating suspension")),

  adjust: (c: PeridotClient, body: { pid: string; deltaXp: number; reason: string }) =>
    c.post<Record<string, unknown>>(`${BASE}/adjustments`, body).then((r) => unwrap(r, "Applying adjustment")),

  reverse: (c: PeridotClient, body: { pid: string; amount: number; reason: string; originalEntryId?: string }) =>
    c.post<Record<string, unknown>>(`${BASE}/reversals`, body).then((r) => unwrap(r, "Applying reversal")),

  ledger: (c: PeridotClient, q?: { pid?: string; kind?: string; limit?: number; offset?: number }) =>
    c
      .get<Page<LedgerEntry>>(`${BASE}/ledger${qs({ pid: q?.pid, kind: q?.kind, limit: q?.limit, offset: q?.offset })}`)
      .then((r) => unwrap(r, "Loading XP history")),

  suspicious: (c: PeridotClient, q?: { reviewed?: boolean; limit?: number; offset?: number }) =>
    c
      .get<Page<SuspiciousRow>>(
        `${BASE}/suspicious${qs({ reviewed: q?.reviewed === undefined ? undefined : String(q.reviewed), limit: q?.limit, offset: q?.offset })}`,
      )
      .then((r) => unwrap(r, "Loading suspicious activity")),

  reviewSuspicious: (c: PeridotClient, id: string, body: { reviewed: boolean; note?: string }) =>
    c
      .patch<SuspiciousRow>(`${BASE}/suspicious/${id}/review`, body)
      .then((r) => unwrap(r, "Saving review")),

  /** Existing admin apps surface (verify/revoke + list) used by the Applications section. */
  listApps: (c: PeridotClient, q?: string) =>
    c.get<XpApp[]>(`/v1/admin/apps${qs({ q })}`).then((r) => unwrap(r, "Loading apps")),

  setVerified: (c: PeridotClient, id: string, verified: boolean) =>
    c.patch<XpApp>(`/v1/admin/apps/${id}/verify`, { verified }).then((r) => unwrap(r, "Saving verification")),
};
