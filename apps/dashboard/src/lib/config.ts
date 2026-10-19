// Dashboard environment resolution. Ported from
// apps/web/app/workspace/_components/workspace-provider.tsx — same behavior,
// Vite env names (VITE_* instead of NEXT_PUBLIC_PID_*).
//
// - Explicit VITE_PID_ENV wins; otherwise the badge follows the API URL
//   (loopback = sandbox) so it can never disagree with where traffic goes.
// - The badge follows the *configured* URL, not the LAN-resolved one —
//   a LAN page still talks to the dev API.

function apiHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

export const CONFIGURED_API_BASE =
  import.meta.env.VITE_API_URL ?? "http://localhost:3300";

export const LOOPBACK = ["localhost", "127.0.0.1", "::1"].includes(
  apiHost(CONFIGURED_API_BASE),
);

export const PID_ENV: string =
  import.meta.env.VITE_PID_ENV ?? (LOOPBACK ? "sandbox" : "production");

// The dashboard is first-party: it authenticates through the wallet app
// (popup) and shares the session cookie. In dev that wallet is the local
// Vite wallet app on :3302.
export const POPUP_URL =
  import.meta.env.VITE_POPUP_URL ??
  (LOOPBACK
    ? "http://localhost:3302"
    : PID_ENV === "production"
      ? "https://app.pid.peridotvault.com"
      : "https://app.sandbox.pid.peridotvault.com");

export const OTHER_WORKSPACE_URL: string | undefined =
  import.meta.env.VITE_OTHER_WORKSPACE_URL;

// The dashboard's own session namespace: its cookies/session are separate
// from the wallet's, so signing out here never signs the user out of the
// wallet. Kept as "web" for backward compatibility — renaming the scope
// would log every developer out.
export const SESSION_SCOPE = "web";
