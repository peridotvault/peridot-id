import { useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { deliverLoginCode, type LoginContext } from "../popup-login";
import type { SsoRequest } from "../sso";
import type { ClaimState } from "./usePidClaim";

export interface LoginFlowFlags {
  /** Guards the double-mint (inline deliver + effect). */
  delivered: boolean;
  /** Session presence at tab open: null = unknown, consent depends on it. */
  hadSessionAtOpen: boolean | null;
}

// Existing wallet session (SSO / login-tab mode): offers one-tap Allow
// instead of forcing a redundant login. undefined = still checking.
export function useLoginSession(
  peridot: PeridotClient,
  opts: {
    sso: SsoRequest | null;
    ctx: LoginContext | null;
    flags: LoginFlowFlags;
    claim: ClaimState;
  },
) {
  const { sso, ctx, flags, claim } = opts;
  const [session, setSession] = useState<{ label: string } | null | undefined>(sso || ctx ? undefined : null);
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    if ((!sso && !ctx) || typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      try {
        // Access tokens are short-lived; a live refresh cookie revives the session
        // without forcing a redundant login.
        let me = await peridot.identity.me();
        if (typeof me === "object" && me !== null && "statusCode" in me) {
          if ((await peridot.auth.refresh()) === true) me = await peridot.identity.me();
        }
        if (cancelled || typeof me !== "object" || me === null || "statusCode" in me) {
          if (!cancelled) {
            if (flags.hadSessionAtOpen === null) flags.hadSessionAtOpen = false;
            setSession(null);
          }
          return;
        }
        const profile = await peridot.profile.me();
        const label =
          typeof profile === "object" && profile !== null && !("statusCode" in profile) && profile.displayName
            ? profile.displayName
            : (me as { pid: string }).pid;
        if (!cancelled) {
          if (flags.hadSessionAtOpen === null) flags.hadSessionAtOpen = true;
          setSession({ label });
        }
      } catch {
        if (!cancelled) setSession(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sso, ctx, peridot]);

  /**
   * Auth-in-a-new-tab delivery: explicit logins in this tab (no session at
   * open, or after "use a different account") deliver once the session exists.
   * A pre-existing session waits for the consent modal's Allow instead.
   * New users first pass through the claim screen below.
   */
  useEffect(() => {
    if (!ctx || !session || claim !== null || flags.delivered) return;
    // A pre-existing session waits for the consent modal's Allow — the app must
    // always be approved (never silently signed in).
    if (flags.hadSessionAtOpen === true && !showLogin) return;
    flags.delivered = true;
    void deliverLoginCode(peridot, ctx);
  }, [ctx, session, claim, showLogin, peridot, flags]);

  return { session, setSession, showLogin, setShowLogin };
}
