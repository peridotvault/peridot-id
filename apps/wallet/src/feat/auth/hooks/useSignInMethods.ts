import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { deliverLoginCode, type LoginContext } from "../popup-login";
import { finishSso, type SsoRequest } from "../sso";
import type { LoginFlowFlags } from "./useLoginSession";

export function useSignInMethods(
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

  const signInWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await peridot.auth.loginWithPasskey(
        ctx ? undefined : sso ? { returnTo: sso.redirectUri, clientId: sso.clientId } : undefined,
      );
      if (!res.ok) {
        setError("Sign-in was cancelled — try again.");
        return;
      }
      if (ctx) {
        flags.delivered = true;
        await deliverLoginCode(peridot, ctx);
        return;
      }
      if (finishSso(sso, res.pidCode)) return;
      onLoggedIn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const continueWithGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      // Google always leaves the page (OAuth redirect). Only cross-origin SSO requests
      // carry a returnTo (an allowlisted third-party origin). A first-party login omits
      // it: window.location.origin here (app.pid.peridotvault.com) is NOT in the server's
      // returnTo allowlist, so sending it 400s (localhost only "worked" because loopback
      // URLs are exempt). Without returnTo the Google callback lands on CLIENT_SUCCESS_URL
      // (= this wallet's origin) with the session cookie — or, for a new credential,
      // on the PID claim screen (the only place handles are chosen).
      // Never navigate on success here: the browser leaves for Google, and the
      // return bootstrap lands back on this tab. On failure (null/throw) stay on
      // login. In auth-in-a-new-tab mode the round-trip returns here (no returnTo)
      // so we can mint the app's pid_code and post it to the opener.
      // Auth-in-a-new-tab: no returnTo — the Google callback returns to this
      // wallet (CLIENT_SUCCESS_URL) so the tab can mint the app's pid_code and
      // post it to the opener. Non-tab SSO keeps the cross-origin returnTo.
      const url = await peridot.auth.login(
        ctx
          ? undefined
          : sso
            ? {
                ...(sso.redirectUri ? { returnTo: sso.redirectUri } : {}),
                ...(sso.clientId ? { clientId: sso.clientId } : {}),
              }
            : undefined,
      );
      if (!url) {
        setError("Couldn't reach Google — try again.");
        return;
      }
      if (typeof window !== "undefined") window.location.assign(url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return { signInWithPasskey, continueWithGoogle };
}
