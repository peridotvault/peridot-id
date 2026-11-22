/**
 * ANT-89 M2 — admin-write catalogs (Tobias C3 + F8).
 *
 * MVP event-type allowlist (C3): `approvedEventTypes` on PidApp is validated
 * at admin write time against strict format only (app-defined event names are
 * allowed; duplicates and oversized lists are refused). Nothing persists on
 * error.
 *
 * Checker registry (F8, R3): MVP restricts verification to `internal_state`
 * + `backend_check` with a per-task `verification.checker`Naming: the checker
 * string is `<verificationType>.<checkerName>`. Tasks without a registered
 * reliable checker cannot be activated — enforced in the admin API (400),
 * never UI-only.
 */

export const EVENT_TYPE_FORMAT = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Suggested event types. Apps may use ANY format-valid type: an app-scoped
 * task's key IS its event type, so the catalog is a starting vocabulary, not
 * a closed list (self-serve tasks, ANT app XP). Format + size stay enforced.
 */
export const MVP_EVENT_TYPES = [
  "onboarding_completed",
  "identity_verified",
  "campaign_completed",
  "achievement_earned",
  "ecosystem_activity",
] as const;
export type MvpEventType = (typeof MVP_EVENT_TYPES)[number];

export function validateEventType(value: string): string | null {
  if (typeof value !== "string" || !EVENT_TYPE_FORMAT.test(value)) {
    return `invalid event-type format: ${value}`;
  }
  return null;
}

/** Validate a full allowlist write atomically: returns ALL errors (caller persists nothing). */
export function validateEventTypeAllowlist(types: unknown): { ok: true; types: string[] } | { ok: false; errors: string[] } {
  if (!Array.isArray(types)) return { ok: false, errors: ["approvedEventTypes must be an array"] };
  if (types.length > 50) return { ok: false, errors: ["approvedEventTypes too large (max 50)"] };
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const t of types) {
    if (typeof t !== "string") {
      errors.push("event type must be a string");
      continue;
    }
    const err = validateEventType(t);
    if (err) {
      errors.push(err);
      continue;
    }
    if (seen.has(t)) {
      errors.push(`duplicate event type: ${t}`);
      continue;
    }
    seen.add(t);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, types: [...seen] };
}

export const VERIFICATION_TYPES = ["internal_state", "backend_check"] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/**
 * Reliable checker registry (R3 MVP). Each checker validates against
 * PeridotID-owned records inside the award transaction (M3 intake).
 * `<type>.<name>` — the task's verificationType must match the prefix.
 */
export const RELIABLE_CHECKERS = [
  "internal_state.onboarding_completed",
  "internal_state.identity_verified",
  "internal_state.campaign_verified",
  "backend_check.achievement_owned",
  "backend_check.activity_verified",
  // Self-serve app events: the app is Verified + active + XP-enabled and the
  // event type is on its approved list (checked in events.service before this
  // runs). Platform keeps the guardrails: idempotency, task caps, quotas,
  // reversals, suspend. XP is cosmetic progression only — never money.
  "backend_check.app_attested",
] as const;
const CHECKER_SET = new Set<string>(RELIABLE_CHECKERS);

export function validateChecker(verificationType: string, checker: string | null | undefined): string | null {
  if (!checker) return "task has no reliable checker registered (verification.checker is required for activation)";
  if (!CHECKER_SET.has(checker)) return `unknown verification checker (not in MVP registry): ${checker}`;
  const [prefix] = checker.split(".");
  if (prefix !== verificationType) {
    return `checker ${checker} does not match verificationType ${verificationType}`;
  }
  return null;
}

export const TASK_KEY_FORMAT = /^[a-z][a-z0-9_]{2,63}$/;
export const TASK_RECURRING = ["once", "daily", "weekly", "monthly", "unlimited"] as const;
export const TASK_STATUSES = ["draft", "active", "disabled", "archived"] as const;
