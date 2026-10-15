// LAN dev: a loopback URL baked at build time (localhost API/popup) points at
// the *viewing* device, not the dev machine, when the page loads from a LAN
// IP. Swap the host for the page host (keep scheme/port/path). SSR-safe:
// without window there is no page host, so return the configured URL.
export function resolveBrowserUrl(configured: string): string {
  if (typeof window === "undefined") return configured;
  try {
    const url = new URL(configured);
    const host = window.location.hostname;
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const remote = host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]";
    if (loopback && remote) url.hostname = host;
    return url.toString().replace(/\/$/, "");
  } catch {
    return configured;
  }
}
