/** Retryable OAuth failure from the callback (?error=). Web only. */
export function readOAuthError(): "oauth_not_configured" | "google_failed" | null {
  if (typeof window === "undefined") return null;
  const code = new URL(window.location.href).searchParams.get("error");
  if (!code) return null;
  return code === "oauth_not_configured" ? "oauth_not_configured" : "google_failed";
}

/** Strip ?error= after showing it inline, so a refresh doesn't re-show it. */
export function stripOAuthError(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("error");
  window.history.replaceState(null, "", url.toString());
}
