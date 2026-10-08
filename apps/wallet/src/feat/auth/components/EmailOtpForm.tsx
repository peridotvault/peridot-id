import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { theme, styles as s } from "../../../shared/theme";
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
    <View style={styles.screen}>
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <View style={s.container}>
        <View style={styles.middle}>
          <View style={styles.masthead}>
            <Text style={styles.title}>Sign in with email</Text>
            <Text style={styles.subtitle}>
              {step === "email" ? "We'll send you a 6-digit code." : `Code sent to ${email}`}
            </Text>
          </View>
          {error && <Text style={s.error}>{error}</Text>}
          <View style={styles.stack}>
            {step === "email" ? (
              <TextInput
                style={[s.input, styles.noGlow]}
                value={email}
                onChangeText={onEmail}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                placeholder="you@example.com"
                placeholderTextColor={theme.colors.mutedForeground}
                editable={!busy}
                onSubmitEditing={onStart}
              />
            ) : (
              <TextInput
                style={[s.input, styles.codeInput, styles.noGlow]}
                value={code}
                onChangeText={(t) => onCode(t.replace(/[^0-9]/g, "").slice(0, 6))}
                keyboardType="number-pad"
                placeholder="––––––"
                placeholderTextColor={theme.colors.mutedForeground}
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
                <Text style={[styles.resend, (busy || resendIn > 0) && styles.resendDisabled]}>
                  {resendIn > 0 ? `Resend in ${resendIn}s` : "Resend code"}
                </Text>
              </Pressable>
            )}
            <Pressable onPress={onBack} disabled={busy}>
              <Text style={styles.back}>← All sign-in options</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  middle: { flex: 1, width: "100%", alignItems: "center", justifyContent: "center", gap: 20 },
  masthead: { alignItems: "center", gap: 8 },
  title: {
    fontSize: 28,
    fontWeight: "400",
    color: theme.colors.foreground,
    fontFamily: "SourceSerif4_400Regular",
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 14, color: theme.colors.mutedForeground, fontFamily: "Geist_400Regular", textAlign: "center" },
  stack: { width: "100%", maxWidth: 343, gap: 12 },
  codeInput: { textAlign: "center", letterSpacing: 8, fontSize: 20 },
  // Web-only: kill the default outer focus ring (border stays as-is).
  noGlow: { outlineWidth: 0, outlineColor: "transparent" },
  resend: { fontSize: 13, color: theme.colors.foreground, textAlign: "center", fontFamily: "Geist_400Regular" },
  resendDisabled: { color: theme.colors.mutedForeground },
  back: { fontSize: 13, color: theme.colors.mutedForeground, textAlign: "center", fontFamily: "Geist_400Regular" },
});
