import { useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { deliverLoginCode, rejectLogin, type LoginContext } from "../popup-login";
import { finishSso, withPidCode, type SsoRequest } from "../sso";
import type { LoginFlowFlags } from "./useLoginSession";

export type HandleStatus = "idle" | "checking" | "free" | "taken" | "invalid";

// Post-auth pending claim (verified credential, no identity yet). undefined =
// still checking, null = none. The claim screen takes over when set.
export type ClaimState = { email: string | null; displayName: string | null } | null | undefined;

// Post-auth PID creation: the handle becomes the permanent `<handle>@pid`
// identity (never changeable, reused, or reassigned). The user must tick the
// permanence acknowledgement before continuing.
export function usePidClaim(
  peridot: PeridotClient,
  opts: {
    sso: SsoRequest | null;
    ctx: LoginContext | null;
    flags: LoginFlowFlags;
    onLoggedIn: () => void;
    setBusy: (b: boolean) => void;
    setError: (e: string | null) => void;
  },
) {
  const { sso, ctx, flags, onLoggedIn, setBusy, setError } = opts;
  const [handle, setHandleRaw] = useState("");
  const [handleStatus, setHandleStatus] = useState<HandleStatus>("idle");
  const [ackPermanent, setAckPermanent] = useState(false);
  const [claim, setClaim] = useState<ClaimState>(undefined);

  /** Pending post-auth claim check (server is source of truth). */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const st = await peridot.auth.claimStatus();
        if (!cancelled) setClaim(st.pending ? { email: st.email ?? null, displayName: st.displayName ?? null } : null);
      } catch {
        if (!cancelled) setClaim(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peridot]);

  /** Live availability check for the PID claim input (server is source of truth). */
  useEffect(() => {
    const h = handle.trim().toLowerCase();
    if (!h) {
      setHandleStatus("idle");
      return;
    }
    if (!/^[a-z0-9_]{3,20}$/.test(h)) {
      setHandleStatus("invalid");
      return;
    }
    let cancelled = false;
    setHandleStatus("checking");
    const t = setTimeout(() => {
      peridot.auth
        .pidAvailable(h)
        .then((res) => {
          if (!cancelled) setHandleStatus(res.available ? "free" : "taken");
        })
        .catch(() => {
          if (!cancelled) setHandleStatus("idle");
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle, peridot]);

  /** In SSO mode, leave this page: the app exchanges the code for its own session. */

  const setHandle = (t: string) => {
    setHandleRaw(t.toLowerCase());
    setAckPermanent(false);
  };

  const claimSignOut = async () => {
    setBusy(true);
    try {
      await peridot.auth.cancelClaim();
    } catch {
      // cancel must never trap the user — the ticket expires on its own
    } finally {
      setClaim(null);
      setHandleRaw("");
      setAckPermanent(false);
      setError(null);
      setBusy(false);
      // Auth-in-a-new-tab: tell the opener PID creation was abandoned, then close.
      if (ctx) rejectLogin(ctx, "pid_creation_cancelled");
    }
  };

  const claimPid = async () => {
    const h = handle.trim().toLowerCase();
    setBusy(true);
    setError(null);
    try {
      const res = await peridot.auth.claim(h);
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        url.searchParams.delete("claim");
        window.history.replaceState(null, "", url.toString());
      }
      // Auth-in-a-new-tab: PID created — mint the app's pid_code and post it back.
      if (ctx) {
        flags.delivered = true;
        await deliverLoginCode(peridot, ctx);
        return;
      }
      // SSO claim: the ticket (server-validated) knows where to go back to.
      // Legacy fallback: SSO params on our own URL. Otherwise stay home.
      if (res.pidCode && res.redirectTo && typeof window !== "undefined") {
        window.location.assign(withPidCode(res.redirectTo, res.pidCode));
        return;
      }
      if (finishSso(sso, res.pidCode)) return;
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return { handle, setHandle, handleStatus, ackPermanent, setAckPermanent, claim, claimPid, claimSignOut };
}
