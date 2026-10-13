import { Pressable, StyleSheet, Text, TextInput, View } from "../../../shared/primitives";
import { theme, styles as s } from "../../../shared/theme";
import { AsciiRidges } from "../../../shared/components/AsciiRidges";
import { UIButton } from "../../../shared/components/UIButton";
import { ArrowRight, Mail } from "../../../shared/icons";

// Brand glyphs (Google "G", Apple logo) — inline SVG, the only two brand
// marks in the wallet. lucide ships no brand icons; two tiny paths beat a
// whole icon-font dependency.
function GoogleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function AppleIcon({ size = 18, color = "#fafafa" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 384 512" fill={color} aria-hidden>
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

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
            icon={<GoogleIcon size={16} />}
          />
          <UIButton
            title="Continue with Apple"
            disabled
            align="left"
            icon={<AppleIcon size={18} color={theme.colors.mutedForeground} />}
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
    fontFamily: theme.fonts.serif,
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 14, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
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
    fontFamily: theme.fonts.sans,
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
  orText: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  stepUp: {
    fontSize: 13,
    color: theme.colors.foreground,
    textAlign: "center",
    fontFamily: theme.fonts.sans,
  },
  legal: {
    fontSize: 11,
    color: theme.colors.mutedForeground,
    textAlign: "center",
    fontFamily: theme.fonts.sans,
  },
});
