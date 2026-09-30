import { useState } from "react";
import type { AccountView } from "@peridotvault/pid-types";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { deliverLoginCode, rejectLogin, type LoginContext } from "../popup-login";
import { withDenied, withPidCode, type SsoRequest } from "../sso";
import type { LoginFlowFlags } from "./useLoginSession";

export function useConsentActions(
  peridot: PeridotClient,
  opts: {
    sso: SsoRequest | null;
    ctx: LoginContext | null;
    flags: LoginFlowFlags;
    setSession: (s: { label: string } | null) => void;
    setShowLogin: (b: boolean) => void;
    setBusy: (b: boolean) => void;
    setError: (e: string | null) => void;
  },
) {
  const { sso, ctx, flags, setSession, setShowLogin, setBusy, setError } = opts;
  // Client-login account picker ("Use a different account"): null = closed.
  const [picker, setPicker] = useState<AccountView[] | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const allowApp = async () => {
    if (!sso) return;
    setBusy(true);
    setError(null);
    try {
      // Mint a code for the CURRENT session — no re-authentication needed.
      const { pidCode } = await peridot.auth.authorize({ returnTo: sso.redirectUri, clientId: sso.clientId });
      window.location.assign(withPidCode(sso.redirectUri, pidCode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const denyApp = () => {
    if (typeof window === "undefined") return;
    if (ctx) {
      rejectLogin(ctx);
      return;
    }
    if (!sso) return;
    window.location.assign(withDenied(sso.redirectUri));
  };

  /** Auth-in-a-new-tab consent: user approved the pre-existing session. */
  const allowCtx = async () => {
    if (!ctx) return;
    setBusy(true);
    setError(null);
    try {
      flags.delivered = true;
      const ok = await deliverLoginCode(peridot, ctx);
      if (!ok) {
        flags.delivered = false;
        setError("Couldn't authorize — try again.");
      }
    } catch (e) {
      flags.delivered = false;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** "Use a different account": pick another linked identity (client login) or
   *  drop the session and log in fresh (third-party SSO). */
  const useDifferentCtx = async () => {
    if (ctx?.firstParty) {
      setBusy(true);
      setPickerError(null);
      try {
        const res = await peridot.auth.accounts();
        setPicker(Array.isArray(res) ? (res as AccountView[]) : []);
      } catch (e) {
        setPickerError(e instanceof Error ? e.message : String(e));
        setPicker([]);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    try {
      await peridot.auth.logout();
    } catch {
      // best-effort: still show the login form even if logout fails
    } finally {
      flags.delivered = false;
      setSession(null);
      setShowLogin(true);
      setBusy(false);
    }
  };

  /** Pick a linked identity for the pending client login, then re-consent. */
  const pickAccount = async (pid: string) => {
    setBusy(true);
    setPickerError(null);
    try {
      if (!(await peridot.auth.switchAccount(pid))) throw new Error("Couldn't switch account.");
      const account = picker?.find((a) => a.pid === pid);
      flags.delivered = false;
      setPicker(null);
      setShowLogin(false);
      setSession({ label: account?.displayName ?? pid });
    } catch (e) {
      setPickerError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Add a brand-new identity for this client login (falls back to the form). */
  const addAccountCtx = () => {
    flags.delivered = false;
    setPicker(null);
    setSession(null);
    setShowLogin(true);
  };

  return {
    allowApp,
    denyApp,
    allowCtx,
    useDifferentCtx,
    pickAccount,
    addAccountCtx,
    picker,
    setPicker,
    pickerError,
  };
}
