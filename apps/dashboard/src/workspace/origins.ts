// Allowed-origin input handling (ANT-346 M9). Mirrors the server's
// normalizeOrigin (apps/api/src/auth/apps.service.ts): bare http(s) origins
// only — no path, query, or fragment. The client normalizes + validates before
// PATCHing so typos fail fast with a readable message; the server allowlist
// stays authoritative and re-validates everything.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** RFC 1918 private IPv4 (LAN dev) — http allowed here as well as loopback. */
function isPrivateIpv4(host: string): boolean {
  if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function httpAllowedForDev(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || isPrivateIpv4(host);
}

/**
 * Normalize a developer-typed origin to its canonical bare form
 * (`https://mygame.dev`, lowercased, no trailing slash). Returns the
 * normalized origin, or an error message when the input is unusable.
 * https is required; http is accepted only for localhost / LAN dev.
 */
export function normalizeOriginInput(value: string): { origin: string } | { error: string } {
  const trimmed = value.trim().replace(/\/+$/, "").toLowerCase();
  if (!trimmed) return { error: "Enter an origin (e.g. https://mygame.dev)." };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "That isn't a valid URL — include the scheme (https://…)." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Origins must be http(s) URLs." };
  }
  if (parsed.protocol === "http:" && !httpAllowedForDev(parsed.hostname)) {
    return { error: "Origins must use https (http is allowed only for localhost / LAN dev)." };
  }
  if (parsed.origin !== trimmed) {
    return { error: "Enter just the origin — no path, query, or fragment (e.g. https://mygame.dev)." };
  }
  return { origin: parsed.origin };
}
