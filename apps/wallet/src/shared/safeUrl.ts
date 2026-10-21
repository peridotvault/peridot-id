// External-URL gate for the wallet (ANT-346 M10). Every out-of-app navigation
// (DOKU checkout pages, Solana explorer links) funnels through Linking.openURL,
// which enforces this check: only https: URLs may open. http is allowed solely
// for loopback hosts so LAN/dev builds keep working; everything else throws
// and the caller surfaces the error instead of navigating.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Throw unless `url` is safe to open externally. Returns the parsed URL. */
export function assertSafeExternalUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Refusing to open an invalid URL.");
  }
  if (parsed.protocol === "https:") return parsed;
  // URL.hostname keeps IPv6 brackets ("[::1]") — strip them for comparison.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(host)) return parsed;
  throw new Error("Refusing to open a non-https URL.");
}
