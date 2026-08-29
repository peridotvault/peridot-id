import { useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";
import { usePeridot } from "../AppContext";

export function TopupScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [amount, setAmount] = useState("1000000");
  const [asset, setAsset] = useState("SOL");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const topup = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await peridot.wallet.topup({ amount, asset });
      setResult(`Terkirim. Signature: ${res.signature}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Top Up</Text>
      <Text style={styles.label}>Jumlah (lamports / unit token)</Text>
      <TextInput style={styles.input} value={amount} onChangeText={setAmount} keyboardType="numeric" />
      <Text style={styles.label}>Aset (SOL atau alamat mint)</Text>
      <TextInput style={styles.input} value={asset} onChangeText={setAsset} />
      {error && <Text style={styles.error}>{error}</Text>}
      {result && <Text selectable style={styles.mono}>{result}</Text>}
      <Button title={busy ? "Mengirim..." : "Top Up"} onPress={topup} disabled={busy} />
      <Button title="Kembali" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 10 },
  title: { fontSize: 24, fontWeight: "700" },
  label: { fontSize: 13, color: "#666" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, fontSize: 15 },
  error: { color: "#c0392b" },
  mono: { fontFamily: "monospace", fontSize: 12 },
});