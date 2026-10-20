// CORS origin policy: first-party env list ∪ every active registered app's origins.
//
// A blanket `*` is impossible here — the SDK sends `credentials: "include"` and browsers
// reject `*` with credentials. It would also let any site read users' identity data.
// Instead, any developer self-serves via POST /v1/apps and their origins work without
// operator involvement (cache refreshes every APP_ORIGINS_TTL_MS).

export const APP_ORIGINS_TTL_MS = 60_000;

/**
 * First-party dual-serve origins (ANT-99/ANT-143): old *.peridotvault.com hosts
 * plus new *.peridot.id hosts, prod + sandbox. Built in (not env-only) so a
 * stale CORS_ORIGINS value in Infisical can never dark-out the new domains —
 * the 2026-10-20 live incident was exactly that (env still old-only). The env
 * list stays additive for one-off overrides. Old hosts are never removed here.
 */
export const FIRST_PARTY_ORIGINS: string[] = [
  // Prod old (kept live, dual-serve).
  "https://app.pid.peridotvault.com",
  "https://pid.peridotvault.com",
  // Prod new (ANT-99 cutover).
  "https://peridot.id",
  "https://dashboard.peridot.id",
  "https://docs.peridot.id",
  // Sandbox old (kept live).
  "https://app.sandbox.pid.peridotvault.com",
  "https://sandbox.pid.peridotvault.com",
  // Sandbox new (ANT-99 cutover).
  "https://sandbox.peridot.id",
  "https://sandbox-dashboard.peridot.id",
];

import type { ConfigService } from "@nestjs/config";
import { resolveServiceUrls, serviceOrigins } from "./app-config";

/** Split a comma-separated env var into origins (trailing slashes stripped). */
export function parseEnvOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Static CORS allow-list (ANT-193): the ONE service-URL set (API/WALLET/
 * DASHBOARD/DOCS) ∪ the built-in first-party dual-serve set ∪ the CORS_ORIGINS
 * additive escape hatch (one-off edges like localhost-against-sandbox; never
 * required per env). Env stays additive, never subtractive.
 */
export function staticOriginsFor(config: ConfigService): string[] {
  const urls = resolveServiceUrls((key, def) => config.get(key, def));
  return [
    ...new Set([
      ...serviceOrigins(urls),
      ...FIRST_PARTY_ORIGINS,
      ...parseEnvOrigins(config.get<string>("CORS_ORIGINS", "")),
    ]),
  ];
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
