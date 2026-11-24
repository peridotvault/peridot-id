import { useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";

export interface AppInfo {
  /** Registered app name; null when the server has none (callers fall back to the origin). */
  name: string | null;
  /** Owner-set https logo; null (or a failed load) renders the generic tile. */
  logoUrl: string | null;
  /** Owner-set tagline for the consent card; null = PeridotID's own line. */
  description: string | null;
  isVerified: boolean;
  /** Login methods the app accepts; missing/unknown = show all (server still enforces). */
  loginMethods: string[] | null;
}

// Public app trust signal + display name + login-method switches (dashboard →
// Integrations). Fail-closed: a failed fetch hides the badge and shows every method.
// `origin` is the requesting app's origin — the server only answers when the app
// owns it, so a borrowed client_id can't put another app's name on the screen.
export function useAppInfo(
  peridot: PeridotClient,
  appClientId: string | undefined,
  origin?: string | null,
): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (!appClientId) return;
    let cancelled = false;
    (async () => {
      const query = `clientId=${encodeURIComponent(appClientId)}${origin ? `&origin=${encodeURIComponent(origin)}` : ""}`;
      try {
        const res = await peridot.get<{ name?: string; logoUrl?: string | null; description?: string | null; isVerified: boolean; loginMethods?: string[] }>(
          `/v1/auth/app-info?${query}`,
        );
        if (!cancelled && res.ok) {
          const data = res.data as {
            name?: string;
            logoUrl?: string | null;
            description?: string | null;
            isVerified: boolean;
            loginMethods?: string[];
          };
          setInfo({
            name: typeof data.name === "string" ? data.name : null,
            logoUrl: typeof data.logoUrl === "string" && data.logoUrl ? data.logoUrl : null,
            description: typeof data.description === "string" && data.description ? data.description : null,
            isVerified: data.isVerified === true,
            loginMethods: Array.isArray(data.loginMethods) ? data.loginMethods : null,
          });
        } else if (!cancelled) {
          // Fail-closed on screen by design, but silence here is what makes a
          // dead popup look like a session bug: 404 = app (or this origin) is
          // not registered, and the login that follows cannot mint a code.
          // eslint-disable-next-line no-console
          console.warn("[app-info] not answered — app or origin not registered:", { clientId: appClientId, origin: origin ?? null, data: res.data });
        }
      } catch {
        // fail-closed: no badge, default methods
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peridot, appClientId, origin]);

  return info;
}
