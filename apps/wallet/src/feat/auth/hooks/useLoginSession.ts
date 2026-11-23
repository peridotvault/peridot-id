import { useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { deliverLoginCode, isExplicitLogin, markExplicitLogin, type LoginContext } from "../utils/popupLogin";
import type { SsoRequest } from "../utils/sso";
import type { ClaimState, LoginFlowFlags, LoginSession } from "../types/login";

// Existing wallet session (SSO / login-tab mode): offers one-tap Allow
// instead of forcing a redundant login. undefined = still checking.
export function useLoginSession(
  peridot: PeridotClient,
  opts: {
    sso: SsoRequest | null;
    ctx: LoginContext | null;
    flags: LoginFlowFlags;
    claim: ClaimState;
    /** Auth-in-a-new-tab code delivered while this window stayed open. */
    onCtxDone?: (denied: boolean) => void;
  },
) {
  const { sso, ctx, flags, claim, onCtxDone } = opts;
  const [session, setSession] = useState<LoginSession | null | undefined>(sso || ctx ? undefined : null);
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
            // No session in this tab: the next login here IS explicit, and the
            // OAuth round-trip must not turn it into "consent needed again".
            markExplicitLogin();
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
          // A session this tab created itself (flag survives the OAuth reload)
          // delivers without a second approval; a pre-existing one asks.
          if (flags.hadSessionAtOpen === null) flags.hadSessionAtOpen = !isExplicitLogin();
          setSession({ label, pid: (me as { pid: string }).pid });
        }
      } catch {
        if (!cancelled) {
          if (flags.hadSessionAtOpen === null) flags.hadSessionAtOpen = false;
          markExplicitLogin();
          setSession(null);
        }
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
    void deliverLoginCode(peridot, ctx).then((ok) => {
      if (ok) onCtxDone?.(false);
      // Failed mint: release the guard so the consent card's Continue can retry
      // (and show the real reason) instead of leaving a dead button.
      else flags.delivered = false;
    });
  }, [ctx, session, claim, showLogin, peridot, flags, onCtxDone]);

  return { session, setSession, showLogin, setShowLogin };
}
