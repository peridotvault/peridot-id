/** Retryable OAuth failure from the callback (?error=). Web only. */
export function readOAuthError(): "oauth_not_configured" | "login_method_disabled" | "google_failed" | null {
  if (typeof window === "undefined") return null;
  const code = new URL(window.location.href).searchParams.get("error");
  if (!code) return null;
  if (code === "oauth_not_configured") return "oauth_not_configured";
  if (code === "login_method_disabled") return "login_method_disabled";
  return "google_failed";
}

/** Strip ?error= after showing it inline, so a refresh doesn't re-show it. */
export function stripOAuthError(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("error");
  window.history.replaceState(null, "", url.toString());
}
