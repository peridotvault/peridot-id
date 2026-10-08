import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { theme, styles as s } from "../../../shared/theme";
import { AsciiRidges } from "../../../shared/components/AsciiRidges";
import { UIButton } from "../../../shared/components/UIButton";
import { ArrowRight, Mail } from "../../../shared/icons";

// Default login form: inline email / Google / Apple / passkey + legal line.
export function LoginOptions({
  busy,
  error,
  stepUp,
  ssoOrigin,
  ctxOrigin,
  email,
  onGoogle,
  onEmailChange,
  onSubmitEmail,
  onPasskey,
}: {
  busy: boolean;
  error: string | null;
  stepUp: boolean;
  ssoOrigin: string | null;
  ctxOrigin: string | null;
  email: string;
  onGoogle: () => void;
  onEmailChange: (t: string) => void;
  onSubmitEmail: () => void;
  onPasskey: () => void;
}) {
  return (
    <View style={styles.screen}>
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <View style={s.container}>
      <View style={styles.middle}>
        <View style={styles.masthead}>
          <Text style={styles.title}>PeridotID</Text>
          {ssoOrigin ? (
            <Text style={styles.subtitle}>Sign in to continue to {ssoOrigin}</Text>
          ) : ctxOrigin ? (
            <Text style={styles.subtitle}>Sign in to continue to {ctxOrigin}</Text>
          ) : null}
        </View>
        {error && <Text style={s.error}>{error}</Text>}
        <View style={styles.stack}>
          <View style={styles.emailRow}>
            <View style={[s.input, styles.emailBox]}>
              <Mail size={16} color={theme.colors.mutedForeground} />
              <TextInput
                style={styles.emailField}
                value={email}
                onChangeText={onEmailChange}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                returnKeyType="go"
                placeholder="Continue with email"
                placeholderTextColor={theme.colors.mutedForeground}
                editable={!busy}
                onSubmitEditing={onSubmitEmail}
              />
            </View>
            <Pressable
              onPress={onSubmitEmail}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Continue with email"
              style={({ pressed }) => [
                styles.submitBtn,
                pressed && !busy && styles.submitPressed,
                busy && styles.submitDisabled,
              ]}
            >
              <ArrowRight size={18} color={theme.colors.background} />
            </Pressable>
          </View>
          <UIButton
            title="Continue with Google"
            onPress={onGoogle}
            disabled={busy}
            align="left"
            icon={<FontAwesome name="google" size={16} color={theme.colors.foreground} />}
          />
          <UIButton
            title="Continue with Apple"
            disabled
            align="left"
            icon={<FontAwesome name="apple" size={18} color={theme.colors.mutedForeground} />}
          />
          <View style={styles.orRow}>
            <View style={styles.hairline} />
            <Text style={styles.orText}>or</Text>
            <View style={styles.hairline} />
          </View>
          {stepUp && (
            <Text style={styles.stepUp}>Session expired — please confirm it's you with your passkey.</Text>
          )}
          <UIButton
            title={busy ? "Waiting for passkey…" : "Select a passkey"}
            onPress={onPasskey}
            disabled={busy}
            variant="primary"
          />
          <Text style={styles.legal}>By continuing, I agree to PeridotID Terms of Use and Privacy notice</Text>
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
    fontSize: 40,
    fontWeight: "400",
    color: theme.colors.foreground,
    fontFamily: "SourceSerif4_400Regular",
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 14, color: theme.colors.mutedForeground, fontFamily: "Geist_400Regular" },
  stack: { width: "100%", maxWidth: 343, gap: 12 },
  emailRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  emailBox: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 15,
    paddingHorizontal: 20,
    backgroundColor: theme.colors.background,
  },
  emailField: {
    flex: 1,
    padding: 0,
    fontSize: 14,
    fontFamily: "Geist_400Regular",
    color: theme.colors.foreground,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  submitBtn: {
    width: 50,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.foreground,
    // Web-only: same focus-ring kill as the email field.
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  submitPressed: { opacity: 0.7 },
  submitDisabled: { opacity: 0.55 },
  orRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  hairline: { flex: 1, height: 1, backgroundColor: theme.colors.border },
  orText: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: "Geist_400Regular" },
  stepUp: {
    fontSize: 13,
    color: theme.colors.foreground,
    textAlign: "center",
    fontFamily: "Geist_400Regular",
  },
  legal: {
    fontSize: 11,
    color: theme.colors.mutedForeground,
    textAlign: "center",
    fontFamily: "Geist_400Regular",
  },
});
