// Dashboard environment resolution. Ported from
// apps/docs/app/workspace/_components/workspace-provider.tsx — same behavior,
// Vite env names (VITE_* instead of NEXT_PUBLIC_PID_*).
//
// - Explicit VITE_PID_ENV wins; otherwise the badge follows the API URL
//   (loopback or sandbox-indicating hostname = sandbox) so it can never
//   disagree with where traffic goes.
// - The badge follows the *configured* URL, not the LAN-resolved one —
//   a LAN page still talks to the dev API.

// Safe import.meta.env access: Vite inlines VITE_* at build time, but plain
// `import.meta.env.X` throws outside a Vite bundle (e.g. node --test). The
// optional chain keeps this module importable in tests.
function viteEnv(key: string): string | undefined {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return env?.[key];
  } catch {
    return undefined;
  }
}

function apiHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Env derivation from the configured API base (ANT-694): explicit build env
 * wins; otherwise loopback OR any sandbox-indicating hostname (canonical
 * `sandbox-*` / `*-sandbox` hosts and legacy `*.sandbox.*` / `sandbox.*`
 * in-fix hosts) resolve to sandbox. Previously every non-loopback host fell
 * through to "production", so a sandbox-API build without VITE_PID_ENV got
 * the PROD wallet popup default — login completed against prod while the API
 * stayed sandbox, and the session never established (silent failure).
 */
export function derivePidEnv(apiBase: string): string {
  const host = apiHost(apiBase);
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return "sandbox";
  if (host.includes("sandbox")) return "sandbox";
  return "production";
}

export const CONFIGURED_API_BASE =
  viteEnv("VITE_API_URL") ?? "http://localhost:3300";

export const LOOPBACK = ["localhost", "127.0.0.1", "::1"].includes(
  apiHost(CONFIGURED_API_BASE),
);

export const PID_ENV: string =
  viteEnv("VITE_PID_ENV") ?? derivePidEnv(CONFIGURED_API_BASE);

// The dashboard is first-party: it authenticates through the wallet app
// (popup) and shares the session cookie. In dev that wallet is the local
// Vite wallet app on :3302.
export const POPUP_URL =
  viteEnv("VITE_POPUP_URL") ??
  (LOOPBACK
    ? "http://localhost:3302"
    : PID_ENV === "production"
      ? "https://peridot.id"
      : "https://sandbox.peridot.id");

export const OTHER_WORKSPACE_URL: string | undefined =
  viteEnv("VITE_OTHER_WORKSPACE_URL") ?? deriveCounterpartWorkspaceUrl(CONFIGURED_API_BASE, PID_ENV);

/**
 * Sandbox MVP (FR-3 / AC-D1): the env-switch link is ALWAYS rendered. When
 * `VITE_OTHER_WORKSPACE_URL` is unset, derive the counterpart dashboard URL
 * from the configured API base instead of hiding the link.
 *
 * Mapping is canonical-dashboard based (separate deployments, never path
 * prefixes): production ⇄ sandbox-dashboard. Legacy vs canonical API hosts
 * both resolve; loopback still resolves to the canonical counterpart so the
 * link never disappears in dev (it just points at the deployed counterpart).
 */
export function deriveCounterpartWorkspaceUrl(apiBase: string, env: string): string {
  const PROD_DASHBOARD = "https://dashboard.peridot.id";
  const SANDBOX_DASHBOARD = "https://sandbox-dashboard.peridot.id";
  void apiBase;
  return env === "production" ? SANDBOX_DASHBOARD : PROD_DASHBOARD;
}

// The dashboard's own session namespace: its cookies/session are separate
// from the wallet's, so signing out here never signs the user out of the
// wallet. Kept as "web" for backward compatibility — renaming the scope
// would log every developer out.
export const SESSION_SCOPE = "web";
