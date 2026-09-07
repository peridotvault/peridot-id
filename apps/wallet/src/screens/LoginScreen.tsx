import { useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { peridot } = usePeridot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await peridot.auth.loginWithPasskey();
      if (!res.ok) {
        setError("Sign-in was cancelled — try again.");
        return;
      }
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
      await peridot.auth.login();
      onLoggedIn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.container}>
      <View style={styles.hero}>
        <Text style={styles.title}>PeridotID</Text>
        <Text style={styles.subtitle}>Gaming identity wallet</Text>
        <Text style={styles.hint}>
          Sign in with a passkey on this device. Google is a recovery fallback — Google login
          alone does not create your on-chain wallet.
        </Text>
      </View>
      {error && <Text style={s.error}>{error}</Text>}
      <Button title={busy ? "Waiting for passkey…" : "Sign in with Passkey"} onPress={signInWithPasskey} disabled={busy} />
      <Button title="Continue with Google" onPress={continueWithGoogle} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  title: { fontSize: 36, fontWeight: "700", color: theme.colors.foreground, fontFamily: "serif" },
  subtitle: { fontSize: 15, color: theme.colors.mutedForeground },
  hint: { fontSize: 12, color: theme.colors.mutedForeground, textAlign: "center", maxWidth: 300 },
});