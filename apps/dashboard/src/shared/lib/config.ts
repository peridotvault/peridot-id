// Dashboard configuration: ONE dashboard origin, TWO APIs.
//
// - Mode (mainnet | testnet) picks the API origin; switching reloads.
// - The env badge follows the mode, never the hostname, so it can never
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

export const CONFIGURED_API_BASE =
  viteEnv("VITE_API_URL") ?? "http://localhost:3300";

/**
 * Testnet API origin: the same dashboard serves both networks (one origin), so
 * the second base is derived from the first (`api.peridot.id` →
 * `sandbox-api.peridot.id`). Local dev keeps ONE API — no second stack to run.
 */
export function testnetSibling(mainnet: string): string {
  try {
    const url = new URL(mainnet);
    const local =
      ["localhost", "127.0.0.1", "::1"].includes(apiHost(mainnet)) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (local || !url.hostname.startsWith("api.")) return mainnet;
    url.hostname = `sandbox-${url.hostname}`;
    return url.toString().replace(/\/$/, "");
  } catch {
    return mainnet;
  }
}

export const CONFIGURED_TESTNET_API_BASE =
  viteEnv("VITE_TEST_API_URL") ?? testnetSibling(CONFIGURED_API_BASE);

export const LOOPBACK = ["localhost", "127.0.0.1", "::1"].includes(
  apiHost(CONFIGURED_API_BASE),
);

/** Which network the dashboard is showing/listening to. */
export type DashboardMode = "mainnet" | "testnet";

export const NETWORK_MODE_KEY = "pid_network_mode";

/**
 * Boot mode: `?env=testnet|mainnet` wins (deep links, bookmarks), else the
 * stored choice, else the build env, else mainnet.
 */
export function readMode(): DashboardMode {
  try {
    if (typeof window !== "undefined") {
      const param = new URLSearchParams(window.location.search).get("env");
      if (param === "testnet" || param === "mainnet") {
        window.localStorage.setItem(NETWORK_MODE_KEY, param);
        return param;
      }
      const stored = window.localStorage.getItem(NETWORK_MODE_KEY);
      if (stored === "testnet" || stored === "mainnet") return stored;
    }
  } catch {
    /* private mode / SSR — fall through */
  }
  return viteEnv("VITE_NETWORK_MODE") === "testnet" ? "testnet" : "mainnet";
}

/** Persist the mode and reload: the API origin is fixed per page load. */
export function setMode(mode: DashboardMode): void {
  try {
    window.localStorage.setItem(NETWORK_MODE_KEY, mode);
  } catch {
    /* non-fatal */
  }
  window.location.reload();
}

export const MODE: DashboardMode = readMode();

/** Env badge/labels follow the mode — never the hostname or a build pin. */
export const PID_ENV: string = MODE === "testnet" ? "sandbox" : "production";

// The dashboard is first-party: it authenticates through the wallet app and
// shares the session cookie. In dev that wallet is the local Vite wallet app
// on :3302. One wallet host serves both networks (`?env=` picks the API).
export const POPUP_URL =
  viteEnv("VITE_POPUP_URL") ??
  (LOOPBACK ? "http://localhost:3302" : "https://peridot.id");

// The dashboard's own session namespace: its cookies/session are separate
// from the wallet's, so signing out here never signs the user out of the
// wallet. Kept as "web" for backward compatibility — renaming the scope
// would log every developer out.
export const SESSION_SCOPE = "web";
