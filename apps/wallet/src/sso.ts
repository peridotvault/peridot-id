/**
 * Third-party SSO helpers, shared by App (routing) and LoginScreen (flow).
 *
 * When this page is opened as `...?redirect_uri=https://app.example/callback` (+
 * optional `client_id`), a successful sign-in returns to the app with `?pid_code=...`
 * instead of entering the wallet. `client_id` is optional (unbound codes then follow
 * the global allowlist), but `redirect_uri` is required — without it there is nowhere
 * to return to.
 * (Web only — passkey ceremonies must run on this PeridotID origin.)
 */

export interface SsoRequest {
  clientId?: string;
  redirectUri: string;
}

export function readSsoParams(): SsoRequest | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const clientId = params.get("client_id") ?? undefined;
    const redirectUri = params.get("redirect_uri") ?? "";
    if (!redirectUri) return null;
    const parsed = new URL(redirectUri);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return { clientId, redirectUri };
  } catch {
    return null;
  }
}

export function withPidCode(redirectUri: string, pidCode: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("pid_code", pidCode);
  return url.toString();
}

export function withDenied(redirectUri: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", "access_denied");
  return url.toString();
}

export function ssoOrigin(redirectUri: string): string {
  try {
    return new URL(redirectUri).origin;
  } catch {
    return redirectUri;
  }
}
