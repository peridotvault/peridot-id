/**
 * ANT-89 M2 — admin-write catalogs (Tobias C3 + F8).
 *
 * MVP event-type allowlist (C3): `approvedEventTypes` on PidApp is validated
 * at admin write time against strict format AND catalog membership. Unknown
 * types are refused with 400 and nothing is persisted.
 *
 * Checker registry (F8, R3): MVP restricts verification to `internal_state`
 * + `backend_check` with a per-task `verification.checker`Naming: the checker
 * string is `<verificationType>.<checkerName>`. Tasks without a registered
 * reliable checker cannot be activated — enforced in the admin API (400),
 * never UI-only.
 */

export const EVENT_TYPE_FORMAT = /^[a-z][a-z0-9_]{2,63}$/;

/** MVP catalog (plan rev 5 §13 / board table). Admin writes outside this fail closed. */
export const MVP_EVENT_TYPES = [
  "onboarding_completed",
  "identity_verified",
  "campaign_completed",
  "achievement_earned",
  "ecosystem_activity",
] as const;
export type MvpEventType = (typeof MVP_EVENT_TYPES)[number];
const MVP_EVENT_SET = new Set<string>(MVP_EVENT_TYPES);

export function validateEventType(value: string): string | null {
  if (!EVENT_TYPE_FORMAT.test(value)) return `invalid event-type format: ${value}`;
  if (!MVP_EVENT_SET.has(value)) return `unknown event type (not in MVP catalog): ${value}`;
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
