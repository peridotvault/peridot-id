import { useEffect } from "react";
import { Pressable } from "../../../shared/components/ui/Pressable";
import { TextField } from "../../../shared/components/ui/TextField";
import { styles as s } from "../../../shared/styles/theme";
import { AsciiRidges } from "../../../shared/components/ui/AsciiRidges";
import { UIButton } from "../../../shared/components/ui/UIButton";
import { AppIdentity } from "./AppIdentity";
import { ConsentShell } from "./ConsentShell";

// Email-OTP form: address step, then the 6-digit code step with resend timer.
// Same card as every other auth screen; the app identity stays visible so a
// dapp-scoped login never loses track of who is asking.
export function EmailOtpForm({
  step,
  email,
  code,
  resendIn,
  busy,
  error,
  origin,
  appName,
  logoUrl,
  description,
  verified,
  onEmail,
  onCode,
  onStart,
  onVerify,
  onBack,
}: {
  step: "email" | "code";
  email: string;
  code: string;
  resendIn: number;
  busy: boolean;
  error: string | null;
  origin?: string | null;
  appName?: string | null;
  logoUrl?: string | null;
  description?: string | null;
  verified?: boolean;
  onEmail: (t: string) => void;
  onCode: (t: string) => void;
  onStart: () => void;
  onVerify: () => void;
  onBack: () => void;
}) {
  // ANT-341 FR1: move focus to the error on failed submit (SR + keyboard).
  useEffect(() => {
    if (error) document.getElementById("login-otp-error")?.focus?.();
  }, [error]);
  return (
    <div className="flex flex-col flex-1 relative">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <ConsentShell>
        <AppIdentity
          origin={origin}
          appName={appName}
          logoUrl={logoUrl}
          description={description}
          verified={verified}
          title="Sign in with email"
          subtitle={step === "email" ? "We'll send you a 6-digit code." : `Code sent to ${email}`}
        />
        {error && <p role="alert" tabIndex={-1} id="login-otp-error" style={s.error}>{error}</p>}
        <div className="flex flex-col w-full gap-3">
          {step === "email" ? (
            <TextField
              id="login-email"
              aria-label="Email address"
              style={s.input}
              className="[--placeholder:var(--color-muted-foreground)] outline-none"
              value={email}
              onChangeText={onEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="you@example.com"
              editable={!busy}
              onSubmitEditing={onStart}
             />
          ) : (
            <TextField
              id="login-otp-code"
              aria-label="6-digit verification code"
              style={s.input}
              className="text-center text-xl tracking-[8px] [--placeholder:var(--color-muted-foreground)] outline-none"
              value={code}
              onChangeText={(t) => onCode(t.replace(/[^0-9]/g, "").slice(0, 6))}
              keyboardType="number-pad"
              placeholder="––––––"
              editable={!busy}
              maxLength={6}
              onSubmitEditing={onVerify}
             />
          )}
          <UIButton
            title={busy ? "Please wait…" : step === "email" ? "Send code" : "Verify"}
            onPress={step === "email" ? onStart : onVerify}
            disabled={busy}
            variant="primary"
          />
          {step === "code" && (
            <Pressable onPress={onStart} disabled={busy || resendIn > 0}>
              <span className={`text-center font-sans text-sm ${busy || resendIn > 0 ? "text-muted-foreground" : "text-foreground"}`}>
                {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
              </span>
            </Pressable>
          )}
          <Pressable onPress={onBack} disabled={busy}>
            <span className="text-center font-sans text-sm text-muted-foreground">← All sign-in options</span>
          </Pressable>
        </div>
      </ConsentShell>
    </div>
  );
}
