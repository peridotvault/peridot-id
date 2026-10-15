import { Pressable, Text, TextInput, View } from "../../../shared/primitives";
import { styles as s } from "../../../shared/theme";
import { AsciiRidges } from "../../../shared/components/AsciiRidges";
import { UIButton } from "../../../shared/components/UIButton";

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
  return (
    <View className="flex-1">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <View style={s.container}>
        <View className="flex-1 w-full items-center justify-center gap-5">
          <View className="items-center gap-2">
            <Text className="font-serif text-[28px] tracking-[-0.4px] text-foreground">Sign in with email</Text>
            <Text className="text-center font-sans text-sm text-muted-foreground">
              {step === "email" ? "We'll send you a 6-digit code." : `Code sent to ${email}`}
            </Text>
          </View>
          {error && <Text style={s.error}>{error}</Text>}
          <View className="w-full max-w-[343px] gap-3">
            {step === "email" ? (
              <TextInput
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
              <TextInput
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
                <Text className={`text-center font-sans text-[13px] ${busy || resendIn > 0 ? "text-muted-foreground" : "text-foreground"}`}>
                  {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                </Text>
              </Pressable>
            )}
            <Pressable onPress={onBack} disabled={busy}>
              <Text className="text-center font-sans text-[13px] text-muted-foreground">← All sign-in options</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
