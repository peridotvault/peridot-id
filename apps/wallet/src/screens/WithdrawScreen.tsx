import { useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";
import { usePeridot } from "../AppContext";

export function WithdrawScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [amount, setAmount] = useState("1000000");
  const [asset, setAsset] = useState("SOL");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const withdraw = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await peridot.wallet.withdraw({ amount, asset, to });
      setResult(`Terkirim. Signature: ${res.signature}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Tarik (Withdraw)</Text>
      <Text style={styles.label}>Jumlah</Text>
      <TextInput style={styles.input} value={amount} onChangeText={setAmount} keyboardType="numeric" />
      <Text style={styles.label}>Aset (SOL atau alamat mint)</Text>
      <TextInput style={styles.input} value={asset} onChangeText={setAsset} />
      <Text style={styles.label}>Tujuan (alamat Solana)</Text>
      <TextInput style={styles.input} value={to} onChangeText={setTo} autoCapitalize="none" />
      <Text style={styles.hint}>Dikonfirmasi dengan passkey (WebAuthn).</Text>
      {error && <Text style={styles.error}>{error}</Text>}
      {result && <Text selectable style={styles.mono}>{result}</Text>}
      <Button title={busy ? "Menunggu passkey..." : "Tarik"} onPress={withdraw} disabled={busy || !to} />
      <Button title="Kembali" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, gap: 10 },
  title: { fontSize: 24, fontWeight: "700" },
  label: { fontSize: 13, color: "#666" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, fontSize: 15 },
  hint: { fontSize: 12, color: "#888" },
  error: { color: "#c0392b" },
  mono: { fontFamily: "monospace", fontSize: 12 },
});