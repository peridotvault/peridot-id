import { Pressable, StyleSheet, Text, View } from "react-native";
import { X } from "lucide-react-native";
import { theme, styles as s } from "../theme";
import { UIButton } from "./UIButton";

// One-tap SSO consent as an overlay modal: dimmed scrim + centered card.
// Rendered over the live app screen (and the login backdrop) — the login
// form itself stays a full screen in LoginScreen.
export function SsoConsentModal({
  origin,
  sessionLabel,
  busy,
  error,
  onAllow,
  onDifferent,
  onDeny,
}: {
  origin: string;
  sessionLabel: string;
  busy: boolean;
  error: string | null;
  onAllow: () => void;
  onDifferent: () => void;
  onDeny: () => void;
}) {
  return (
    <View style={styles.overlay}>
      <View style={styles.scrim} />
      <View style={styles.card}>
        <Pressable onPress={onDeny} disabled={busy} style={styles.close} accessibilityLabel="Deny and close">
          <X size={18} color={theme.colors.mutedForeground} />
        </Pressable>
        <Text style={styles.title}>PeridotID</Text>
        <Text style={styles.subtitle}>Allow {origin} to sign in with your PeridotID?</Text>
        <Text style={styles.hint}>
          Signed in as {sessionLabel}. The app receives your ID, display name and email — never your passkeys.
        </Text>
        {error && <Text style={s.error}>{error}</Text>}
        <View style={styles.actions}>
          <UIButton title={busy ? "Authorizing…" : "Allow"} onPress={onAllow} disabled={busy} variant="primary" />
          <UIButton title="Use a different account" onPress={onDifferent} disabled={busy} />
          <UIButton title="Deny" onPress={onDeny} disabled={busy} variant="danger" />
        </View>
      </View>
    </View>
  );
}

const c = theme.colors;
const f = theme.fonts;

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    // Above HomeScreen (mounted after us): without this the opaque home
    // paints clean over the transparent overlay root. Elevation for Android.
    zIndex: 10,
    elevation: 10,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.6)",
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 0,
    padding: 20,
    gap: 12,
  },
  close: {
    position: "absolute",
    top: 8,
    right: 8,
    padding: 8,
    zIndex: 1,
  },
  title: {
    fontSize: 28,
    fontWeight: "400",
    color: c.foreground,
    fontFamily: "SourceSerif4_400Regular",
    letterSpacing: -0.3,
    textAlign: "center",
  },
  subtitle: { fontSize: 14, color: c.foreground, fontFamily: f.sansMedium, textAlign: "center" },
  hint: { fontSize: 12, color: c.mutedForeground, fontFamily: f.sans, textAlign: "center" },
  actions: { gap: 12, marginTop: 4 },
});
