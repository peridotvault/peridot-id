import { useEffect } from "react";
import { Pressable } from "../../../shared/components/ui/Pressable";
import { TextField } from "../../../shared/components/ui/TextField";
import { styles as s } from "../../../shared/styles/theme";
import { AsciiRidges } from "../../../shared/components/ui/AsciiRidges";
import { UIButton } from "../../../shared/components/ui/UIButton";

// Email-OTP form: address step, then the 6-digit code step with resend timer.
export function EmailOtpForm({
  step,
  email,
  code,
  resendIn,
  busy,
  error,
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
    <div className="flex flex-col flex-1">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <div style={s.container} className="flex flex-col">
        <div className="flex flex-col flex-1 w-full items-center justify-center gap-5">
          <div className="flex flex-col items-center gap-2">
            <span className="font-serif text-3xl tracking-[-0.4px] text-foreground">Sign in with email</span>
            <span className="text-center font-sans text-sm text-muted-foreground">
              {step === "email" ? "We'll send you a 6-digit code." : `Code sent to ${email}`}
            </span>
          </div>
          {error && <p role="alert" tabIndex={-1} id="login-otp-error" style={s.error}>{error}</p>}
          <div className="flex flex-col w-full max-w-[343px] gap-3">
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
        </div>
      </div>
    </div>
  );
}
