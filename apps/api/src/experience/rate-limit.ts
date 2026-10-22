/**
 * ANT-89 M3 (ANT-441) — intake throttle tiers (Tobias F5).
 *
 * The global default (100/min, IP-keyed) stays as the outer bound. Intake
 * adds two INNER tiers keyed below it:
 * - `xp-intake-app` (60/min per client_id): bounds one app's total pressure.
 * - `xp-intake-app-pid` (30/min per client_id + user_id): bounds per-subject
 *   pressure (spam against a single PID, enumeration-adjacent floods).
 *
 * Trackers fall back to the request IP when the body carries no usable
 * client_id, so unauthenticated floods still group instead of sharing one
 * global bucket. Tune the numbers here — never per-route magic literals.
 */
export const XP_INTAKE_APP_THROTTLER = { name: "xp-intake-app", ttl: 60000, limit: 60 } as const;
export const XP_INTAKE_APP_PID_THROTTLER = { name: "xp-intake-app-pid", ttl: 60000, limit: 30 } as const;

function bodyClientId(req: Record<string, unknown>): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const id = body?.client_id;
  return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : null;
}

function bodyUserId(req: Record<string, unknown>): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const id = body?.user_id;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : null;
}

function ipOf(req: Record<string, unknown>): string {
  const ip = (req as { ip?: unknown }).ip;
  return typeof ip === "string" && ip.length > 0 ? ip : "unknown";
}

/** Per-app tier tracker (Tobias F5). */
export function xpIntakeAppTracker(req: Record<string, unknown>): string {
  return `xp-intake-app:${bodyClientId(req) ?? ipOf(req)}`;
}

/** Per-app+subject tier tracker (Tobias F5). */
export function xpIntakeAppPidTracker(req: Record<string, unknown>): string {
  const app = bodyClientId(req) ?? ipOf(req);
  return `xp-intake-app-pid:${app}:${bodyUserId(req) ?? "-"}`;
}
