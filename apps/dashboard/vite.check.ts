// Build-time API URL guard (ANT-346 M11). Staging/prod bundles are built with
// `--mode production`; those bundles must talk https. Dev (serve/preview and
// any non-production mode) keeps allowing http loopback/LAN. Unset means the
// Dockerfile fallback (https) applies, so only a set-but-http value fails.

/** Returns an error message when the URL is unacceptable, else null. */
export function prodApiUrlError(raw: string | undefined, mode: string): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `VITE_API_URL is not a valid URL: ${raw}`;
  }
  if (mode !== "production") return null;
  if (parsed.protocol === "https:") return null;
  return `VITE_API_URL must use https in production builds, got: ${raw}`;
}
