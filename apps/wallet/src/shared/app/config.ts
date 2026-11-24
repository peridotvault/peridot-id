// PeridotID wallet app configuration. Override via env for different environments.

// Network mode: "mainnet" (real money, identity) or "testnet" (uji). One build
// serves both; the mode picks the API origin, and switching reloads the app so
// no client/cache can straddle two networks. Identity (PID, passkey, session)
// lives in the mainnet deployment — the testnet API forwards those routes.
export type NetworkMode = "mainnet" | "testnet";

export const NETWORK_MODE_KEY = "pid_network_mode";

// The SDK prepends `/v1/...` paths, so baseUrl is the origin (no trailing /v1).
// Chains/RPC come from the API registry — no Solana env here.
const devHost = typeof window !== "undefined" ? window.location.hostname : "localhost";

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};

// LAN dev: the page loads from 192.168.x.x but a configured loopback URL
// would point at the *viewing* device, not the dev machine. Swap the host
// (keep scheme/port/path) so any LAN IP just works with zero per-machine env.
function resolveBaseUrl(configured: string | undefined): string {
  const fallback = `http://${devHost}:3300`;
  if (!configured) return fallback;
  try {
    const url = new URL(configured);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const remotePage = devHost !== "localhost" && devHost !== "127.0.0.1" && devHost !== "[::1]";
    if (loopback && remotePage) url.hostname = devHost;
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

/** `https://api.peridot.id` → `https://testnet-api.peridot.id`; local dev keeps one API. */
function testnetSibling(mainnet: string): string {
  try {
    const url = new URL(mainnet);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (local || !url.hostname.startsWith("api.")) return mainnet;
    url.hostname = `testnet-${url.hostname}`;
    return url.toString().replace(/\/$/, "");
  } catch {
    return mainnet;
  }
}

/** Mainnet API origin: identity + real money. */
export const MAINNET_API_BASE_URL = resolveBaseUrl(env.VITE_API_URL);

/** Testnet API origin: same code, separate DB, test money. No extra env needed. */
export const TESTNET_API_BASE_URL = resolveBaseUrl(env.VITE_TEST_API_URL ?? testnetSibling(MAINNET_API_BASE_URL));

function persist(mode: NetworkMode): NetworkMode {
  try {
    window.localStorage.setItem(NETWORK_MODE_KEY, mode);
  } catch {
    /* private mode — the in-memory value still drives this load */
  }
  return mode;
}

/**
 * Boot mode. A `?env=testnet|mainnet` param (popup/embed opened by a dapp)
 * wins and is persisted, so that window talks to the dapp's own network.
 */
function readMode(): NetworkMode {
  try {
    if (typeof window !== "undefined") {
      const param = new URLSearchParams(window.location.search).get("env");
      if (param === "testnet" || param === "mainnet") return persist(param);
      const raw = window.localStorage.getItem(NETWORK_MODE_KEY);
      if (raw === "mainnet" || raw === "testnet") return raw;
    }
  } catch {
    /* private mode — fall through to env/default */
  }
  if (env.VITE_NETWORK_MODE === "testnet") return "testnet";
  return "mainnet";
}

export const BOOT_NETWORK_MODE: NetworkMode = readMode();

/** API origin for the selected mode (fixed for this page load; switch = reload). */
export const API_BASE_URL = BOOT_NETWORK_MODE === "testnet" ? TESTNET_API_BASE_URL : MAINNET_API_BASE_URL;
