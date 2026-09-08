// CORS origin policy: first-party env list ∪ every active registered app's origins.
//
// A blanket `*` is impossible here — the SDK sends `credentials: "include"` and browsers
// reject `*` with credentials. It would also let any site read users' identity data.
// Instead, any developer self-serves via POST /v1/apps and their origins work without
// operator involvement (cache refreshes every APP_ORIGINS_TTL_MS).

export const APP_ORIGINS_TTL_MS = 60_000;

/** Split a comma-separated env var into origins (trailing slashes stripped). */
export function parseEnvOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Exact origin match. `undefined` origin = non-browser client (curl, mobile) — allowed. */
export function isOriginAllowed(
  origin: string | undefined,
  staticOrigins: string[],
  appOrigins: string[],
): boolean {
  if (!origin) return true;
  const normalized = origin.replace(/\/+$/, "");
  return staticOrigins.includes(normalized) || appOrigins.includes(normalized);
}
