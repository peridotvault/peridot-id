import { useEffect, useState } from "react";
import { Linking, StyleSheet, Text, TextInput, View } from "react-native";
import type { TopupView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

export function TopupScreen({ onDone, goHistory }: { onDone: () => void; goHistory: () => void }) {
  const { peridot } = usePeridot();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [topup, setTopup] = useState<TopupView | null>(null);

  // Poll the invoice while it is pending (webhook usually lands in seconds).
  useEffect(() => {
    if (!topup || topup.status !== "pending") return;
    const id = setInterval(async () => {
      try {
        const fresh = await peridot.fiat.topup(topup.id);
        setTopup(fresh);
      } catch {
        // transient — keep polling until the user leaves
      }
    }, 5000);
    return () => clearInterval(id);
  }, [peridot, topup]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setTopup(null);
    try {
      const trimmed = amount.replace(/\D/g, "");
      if (!/^\d+$/.test(trimmed) || BigInt(trimmed) < 10_000n) {
        setError("Minimum top-up is Rp10.000.");
        return;
      }
      setTopup(await peridot.fiat.createTopup(trimmed));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openPaymentPage = async () => {
    if (!topup?.paymentUrl) return;
    try {
      await Linking.openURL(topup.paymentUrl);
    } catch {
      setError("Could not open the payment page — copy the URL from history instead.");
    }
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>Top Up</Text>
      <Text style={s.subtitle}>Pay with any DOKU method (VA, QRIS, e-wallet, cards, retail). Fiat balance only — no crypto conversion yet.</Text>

      <Text style={s.label}>Amount (IDR)</Text>
      <TextInput
        style={s.input}
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
        placeholder="50000"
        placeholderTextColor={theme.colors.mutedForeground}
      />

      <UIButton title={busy ? "Creating…" : "Create payment"} onPress={create} disabled={busy} variant="primary" />

      {error && <Text style={s.error}>{error}</Text>}

      {topup && (
        <View style={styles.card}>
          <Text style={styles.invoice}>{topup.invoiceNumber}</Text>
          <Text style={styles.amount}>{fmtIdr(topup.amountIdr)}</Text>
          <Text style={[styles.status, topup.status === "paid" && styles.paid]}>
            {topup.status === "paid"
              ? "Paid — payment confirmed"
              : topup.status === "pending"
                ? "Waiting for payment…"
                : `Payment ${topup.status}`}
          </Text>
          {topup.status === "pending" && topup.paymentUrl && (
            <UIButton title="Open DOKU payment page" onPress={openPaymentPage} />
          )}
        </View>
      )}

      <UIButton title="Top-up history" onPress={goHistory} />
      <UIButton title="Back" onPress={onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    gap: 6,
  },
  invoice: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.mono },
  amount: { fontSize: 24, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  status: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  paid: { color: theme.colors.success },
});
