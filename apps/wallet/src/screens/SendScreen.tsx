import { useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";

const LAMPORTS_PER_SOL = 1e9;

export function SendScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState("SOL");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The SDK expects raw lamports / token units. SOL entries are entered in SOL and
  // converted here; token entries must be whole raw units.
  const toLamports = (input: string): string | null => {
    const trimmed = input.trim();
    if (asset === "SOL") {
      const sol = Number(trimmed);
      if (!Number.isFinite(sol) || sol <= 0) return null;
      return String(BigInt(Math.round(sol * LAMPORTS_PER_SOL)));
    }
    if (!/^\d+$/.test(trimmed)) return null;
    return trimmed;
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const lamports = toLamports(amount);
      if (lamports === null) {
        setError(asset === "SOL" ? "Enter an amount greater than 0." : "Token amounts must be whole raw units.");
        return;
      }
      const res = await peridot.wallet.withdraw({ amount: lamports, asset, to });
      const feeSol = Number(BigInt(res.relayFeeLamports)) / LAMPORTS_PER_SOL;
      if (res.status === "confirmed") {
        setResult(
          `Sent and confirmed on-chain. Network fee ${feeSol.toFixed(6)} SOL was reimbursed from your balance.\nSignature: ${res.signature}`,
        );
      } else {
        // Server already waited ~8s; give it a few more before reporting pending.
        const outcome = await peridot.wallet.waitForConfirmation(res.signature, 6, 1200).catch(() => "pending");
        if (outcome === "confirmed") {
          setResult(
            `Sent and confirmed on-chain. Network fee ${feeSol.toFixed(6)} SOL was reimbursed from your balance.\nSignature: ${res.signature}`,
          );
        } else if (outcome === "failed") {
          setError("The transaction failed on-chain — the Solana network rejected it. No funds were moved.");
        } else {
          setError(
            "Transaction submitted but not yet confirmed. Check your Activity in a moment — no funds were lost.",
          );
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>Send</Text>
      <Text style={s.label}>Destination (Solana address)</Text>
      <TextInput style={s.input} value={to} onChangeText={setTo} autoCapitalize="none" placeholder="Recipient address" placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.label}>Amount ({asset === "SOL" ? "SOL" : "raw units"})</Text>
      <TextInput style={s.input} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={asset === "SOL" ? "0.5" : "0"} placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.label}>Asset (SOL or mint address)</Text>
      <TextInput style={s.input} value={asset} onChangeText={setAsset} autoCapitalize="none" placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.hint}>{asset === "SOL" ? "Amount is in SOL. Confirmed with your passkey (WebAuthn)." : "Token amounts are in raw units. Confirmed with your passkey (WebAuthn)."}</Text>
      {error && <Text style={s.error}>{error}</Text>}
      {result && <Text selectable style={s.mono}>{result}</Text>}
      <Button title={busy ? "Sending…" : "Send"} onPress={send} disabled={busy || !to || !amount} />
      <Button title="Back" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({});