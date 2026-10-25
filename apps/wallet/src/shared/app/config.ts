// PeridotID wallet app configuration. Override via env for different environments.

// The SDK prepends `/v1/...` paths, so baseUrl is the origin (no trailing /v1).
// Chains/RPC come from the API registry — no Solana env here.
const devHost = typeof window !== "undefined" ? window.location.hostname : "localhost";

const configured =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ??
  (typeof process !== "undefined"
    ? (process as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL
    : undefined);

// LAN dev: the page loads from 192.168.x.x but a configured loopback URL
// would point at the *viewing* device, not the dev machine. Swap the host
// (keep scheme/port/path) so any LAN IP just works with zero per-machine env.
function resolveBaseUrl(): string {
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

export const API_BASE_URL = resolveBaseUrl();
