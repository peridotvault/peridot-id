// Permanent ecosystem-wide identity: `<handle>@pid` (e.g. `ifal@pid`).
// The handle is user-chosen once at onboarding, lowercase, immutable, never
// reused or reassigned. Mutable labels (displayName/avatar) live on Profile.
export const PID_HANDLE_REGEX = /^[a-z0-9_]{3,20}$/;
export const PID_REGEX = /^[a-z0-9_]{3,20}@pid$/;
export const PID_SUFFIX = "@pid";

/** Lowercase + trim. Identity IDs are always stored in this form. */
export function normalizePidHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

/**
 * ANT-804 edge 1: canonical server-side normalization for claim intake.
 * NFKC + strip zero-width/invisible chars + trim + lowercase, so unicode
 * confusable padding, surrounding spaces, and capitalization collapse to one
 * canonical handle before validation. Visually-confusable but distinct
 * spellings (e.g. `perid0t` vs `peridot`) stay distinct — those are covered
 * by the curated trademark list in takedown review, not by folding.
 */
export function canonicalizePidHandle(handle: string): string {
  return (handle ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .trim()
    .toLowerCase();
}

export function isPidHandle(handle: string): boolean {
  return PID_HANDLE_REGEX.test(handle);
}

/** `ifal` -> `ifal@pid`. Throws on invalid handle (trust-boundary guard). */
export function toPid(handle: string): string {
  const h = normalizePidHandle(handle);
  if (!isPidHandle(h)) throw new Error("Invalid PID handle");
  return `${h}${PID_SUFFIX}`;
}

export function isPid(value: string): boolean {
  return PID_REGEX.test(value);
}
