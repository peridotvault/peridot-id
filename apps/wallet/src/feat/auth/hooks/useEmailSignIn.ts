import { useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { deliverLoginCode, type LoginContext } from "../popup-login";
import { finishSso, type SsoRequest } from "../sso";
import type { LoginFlowFlags } from "./useLoginSession";

const RESEND_COOLDOWN_S = 60;

// Email-OTP sign-in: request a 6-digit code, then verify. Mirrors the
// passkey/Google sso+ctx delivery (pid_code for RPs, deliverLoginCode for
// auth-in-a-new-tab); new addresses resolve into the claim screen via
// refreshClaim.
export function useEmailSignIn(
  peridot: PeridotClient,
  opts: {
    sso: SsoRequest | null;
    ctx: LoginContext | null;
    flags: LoginFlowFlags;
    onLoggedIn: () => void;
    refreshClaim: () => Promise<void>;
    setBusy: (b: boolean) => void;
    setError: (e: string | null) => void;
  },
) {
  const { sso, ctx, flags, onLoggedIn, refreshClaim, setBusy, setError } = opts;
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const ssoOpts = () =>
    ctx ? undefined : sso ? { returnTo: sso.redirectUri, clientId: sso.clientId } : undefined;

  const start = async () => {
    const addr = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await peridot.auth.emailStart(addr);
      setEmail(addr);
      setStep("code");
      setCode("");
      setResendIn(RESEND_COOLDOWN_S);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await peridot.auth.emailVerify(email, code.trim(), ssoOpts());
      if (res.pendingClaim) {
        await refreshClaim();
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setStep("email");
    setCode("");
    setError(null);
  };

  return { step, email, setEmail, code, setCode, resendIn, start, verify, reset };
}
