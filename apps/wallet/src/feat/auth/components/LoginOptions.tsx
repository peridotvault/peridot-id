import { StyleSheet, Text, View } from "react-native";
import FontAwesome from "@expo/vector-icons/FontAwesome";
import { theme, styles as s } from "../../../shared/theme";
import { AsciiRidges } from "../../../shared/components/AsciiRidges";
import { UIButton } from "../../../shared/components/UIButton";

// Default login form: Google / Apple / passkey + legal line.
export function LoginOptions({
  busy,
  error,
  stepUp,
  ssoOrigin,
  ctxOrigin,
  onGoogle,
  onPasskey,
}: {
  busy: boolean;
  error: string | null;
  stepUp: boolean;
  ssoOrigin: string | null;
  ctxOrigin: string | null;
  onGoogle: () => void;
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
          <UIButton
            title="Continue with Google"
            onPress={onGoogle}
            disabled={busy}
            icon={<FontAwesome name="google" size={16} color={theme.colors.foreground} />}
          />
          <UIButton
            title="Continue with Apple"
            note="Coming soon"
            disabled
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
