import { useCallback, useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Authority } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";

export function PasskeyScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [authorities, setAuthorities] = useState<Authority[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await peridot.passkey.list();
    setAuthorities(Array.isArray(res) ? (res as Authority[]) : []);
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      await peridot.passkey.register();
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Passkey</Text>
      <Text style={styles.subtitle}>
        Passkey adalah kewenangan dompet Anda (secp256r1). Daftarkan di perangkat untuk
        mengotorisasi penarikan.
      </Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <Button title={busy ? "Menunggu passkey..." : "Daftarkan Passkey"} onPress={register} disabled={busy} />
      {authorities.map((a) => (
        <View key={a.id} style={styles.card}>
          <Text style={styles.mono}>ID: {a.credentialId?.slice(0, 24)}...</Text>
          <Text style={styles.mono}>Pubkey: {a.publicKey?.slice(0, 32)}...</Text>
        </View>
      ))}
      <Button title="Kembali" onPress={onDone} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 14 },
  title: { fontSize: 24, fontWeight: "700" },
  subtitle: { fontSize: 13, color: "#666" },
  card: { backgroundColor: "#f2f2f5", borderRadius: 10, padding: 12, gap: 4 },
  mono: { fontFamily: "monospace", fontSize: 12 },
  error: { color: "#c0392b" },
});