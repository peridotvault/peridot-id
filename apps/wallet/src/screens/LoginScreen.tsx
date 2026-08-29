import { useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import { usePeridot } from "../AppContext";

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const { peridot } = usePeridot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async () => {
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
    <View style={styles.container}>
      <Text style={styles.title}>PeridotID Wallet</Text>
      <Text style={styles.subtitle}>Gaming identity wallet</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <Button title={busy ? "Membuka Google..." : "Masuk dengan Google"} onPress={login} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 16 },
  title: { fontSize: 28, fontWeight: "700" },
  subtitle: { fontSize: 15, color: "#666" },
  error: { color: "#c0392b" },
});