import { useState } from "react";
import type { AccountView } from "@peridotvault/pid-types";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { deliverLoginCode, markExplicitLogin, rejectLogin, type LoginContext } from "../utils/popupLogin";
import { withDenied, withPidCode, type SsoRequest } from "../utils/sso";
import type { LoginFlowFlags, LoginSession } from "../types/login";
import { clearApiCache } from "../../../shared/data/apiCache";
import { play } from "../../../shared/sfx/player";

/** The one pause before the browser leaves, hardcoded on purpose (no env). */
const handoff = () => new Promise<void>((resolve) => setTimeout(resolve, 2000));
export function useConsentActions(
  peridot: PeridotClient,
  opts: {
    sso: SsoRequest | null;
    ctx: LoginContext | null;
    flags: LoginFlowFlags;
    setSession: (s: LoginSession | null) => void;
    setShowLogin: (b: boolean) => void;
    setBusy: (b: boolean) => void;
    setError: (e: string | null) => void;
    /** Auth-in-a-new-tab flow resolved while this window stayed open. */
    onCtxDone?: (denied: boolean) => void;
  },
) {
  const { sso, ctx, flags, setSession, setShowLogin, setBusy, setError, onCtxDone } = opts;
  // Client-login account picker ("Use a different account"): null = closed.
  const [picker, setPicker] = useState<AccountView[] | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // Code minted, redirect in flight: the screen swaps to the signing animation.
  const [signing, setSigning] = useState(false);

  const allowApp = async () => {
    if (!sso) return;
    setBusy(true);
    setError(null);
    try {
      // Mint a code for the CURRENT session — no re-authentication needed.
      const { pidCode } = await peridot.auth.authorize({ returnTo: sso.redirectUri, clientId: sso.clientId });
      // Same beat as Internet Identity's redirect view: show the handoff
      // before the browser leaves, instead of a frozen consent card.
      setSigning(true);
      play("signed-in");
      await handoff();
      window.location.assign(withPidCode(sso.redirectUri, pidCode));
    } catch (e) {
      setSigning(false);
      setError(e instanceof Error ? e.message : String(e));
      play("failed");
    } finally {
      setBusy(false);
    }
  };

  const denyApp = () => {
    if (typeof window === "undefined") return;
    play("cancelled");
    if (ctx) {
      rejectLogin(ctx);
      onCtxDone?.(true);
      return;
    }
    if (!sso) return;
    window.location.assign(withDenied(sso.redirectUri));
  };

  /** Auth-in-a-new-tab consent: user approved the pre-existing session. */
  const allowCtx = async () => {
    if (!ctx || flags.delivered) return;
    setBusy(true);
    setError(null);
    try {
      flags.delivered = true;
      // The popup-login path closed the window the instant the code was
      // delivered, so the animation never had a frame. deliverLoginCode owns
      // the handoff beat now.
      setSigning(true);
      const ok = await deliverLoginCode(peridot, ctx);
      if (!ok) {
        flags.delivered = false;
        setSigning(false);
        setError("Couldn't authorize — try again.");
        play("failed");
      } else {
        play("signed-in");
        onCtxDone?.(false);
      }
    } catch (e) {
      flags.delivered = false;
      setSigning(false);
      setError(e instanceof Error ? e.message : String(e));
      play("failed");
    } finally {
      setBusy(false);
    }
  };

  /** Profile popover: load every identity in this browser for the consent card.
   *  Switching never signs the wallet out — an app's login must not end the
   *  user's wallet session. */
  const openAccounts = async () => {
    setBusy(true);
    setPickerError(null);
    setPicker([]);
    try {
      const res = await peridot.auth.accounts();
      setPicker(Array.isArray(res) ? (res as AccountView[]) : []);
    } catch (e) {
      setPickerError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Pick a linked identity for the pending client login, then re-consent. */
  const pickAccount = async (pid: string) => {
    setBusy(true);
    setPickerError(null);
    try {
      if (!(await peridot.auth.switchAccount(pid))) throw new Error("Couldn't switch account.");
      clearApiCache();
      play("account-switched");
      const account = picker?.find((a) => a.pid === pid);
      flags.delivered = false;
      setPicker(null);
      setShowLogin(false);
      setSession({ label: account?.displayName ?? pid, pid });
    } catch (e) {
      setPickerError(e instanceof Error ? e.message : String(e));
      play("failed");
    } finally {
      setBusy(false);
    }
  };

  /** Add a brand-new identity for this client login (falls back to the form). */
  const addAccountCtx = () => {
    flags.delivered = false;
    // The login that follows happens here and now: don't ask for consent again
    // once the OAuth round-trip lands the new session (the flag survives it).
    markExplicitLogin();
    setPicker(null);
    setSession(null);
    setShowLogin(true);
  };

  return {
    allowApp,
    denyApp,
    allowCtx,
    signing,
    openAccounts,
    pickAccount,
    addAccountCtx,
    picker,
    setPicker,
    pickerError,
  };
}
