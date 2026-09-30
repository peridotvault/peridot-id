import { useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "../shared/icons";
import { usePeridot } from "../shared/AppContext";
import { theme, styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";
import { fmtIdr } from "../shared/fiat";
import { FiatQuoteBreakdown } from "../feat/fiat/components/FiatQuoteBreakdown";
import { digitsOnly, groupDigits, MIN_NET_IDR } from "../feat/fiat/utils/topup-amount";
import { useDepositQuote } from "../feat/fiat/hooks/useDepositQuote";
import { useCheckoutSync } from "../feat/fiat/hooks/useCheckoutSync";

/**
 * Top up the internal fiat ledger via DOKU Checkout. Enter the NET amount you
 * want credited; the PeridotID checkout summary shows Amount, the combined
 * Transfer Fee (PeridotID fee + PPN, DOKU gateway fee + PPN), any app fee, and
 * the Total Payment — so you know the final amount before DOKU. Pay opens the
 * DOKU-hosted page (all banks, QRIS, e-money, cards). After paying, tap Check
 * payment status (auto-checked once on return) — your Saldo updates with the
 * exact quoted net once the payment is confirmed.
 */
export function TopupScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [net, setNet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const q = useDepositQuote(peridot, net, setError);
  const sync = useCheckoutSync(peridot);

  const digits = net.replace(/\D/g, "");
  const belowMin = /^\d+$/.test(digits) && BigInt(digits) > 0n && BigInt(digits) < MIN_NET_IDR;

  const openUrl = (url: string) => {
    Linking.openURL(url).catch(() => setError("Could not open the payment page."));
  };

  const createCheckout = async () => {
    setBusy(true);
    setError(null);
    sync.setPending(null);
    try {
      if (!/^\d+$/.test(digits) || BigInt(digits) <= 0n) {
        setError("Enter the net amount you want credited.");
        return;
      }
      if (BigInt(digits) < MIN_NET_IDR) {
        setError("Minimum top-up is Rp100.000.");
        return;
      }
      if (!q.method) {
        setError("No payment methods available right now.");
        return;
      }
      const deposit = await peridot.fiat.checkoutDeposit(digits, undefined, q.method);
      sync.setPending(deposit);
      setNet("");
      q.setQuote(null);
      // Take the user straight to payment — the manual button below remains
      // as fallback when deep-linking is blocked.
      openUrl(deposit.paymentUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={s.container}>
      <TouchableOpacity style={styles.back} onPress={onDone} accessibilityLabel="Back">
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>
      <Text style={s.title}>Top Up</Text>
      <Text style={s.subtitle}>Enter what you want credited — you pay that plus the fees shown below.</Text>

      <View style={styles.card}>
        <Text style={s.label}>Amount credited to you (IDR)</Text>
        <TextInput style={s.input} value={groupDigits(net)} onChangeText={(t) => setNet(digitsOnly(t))} keyboardType="numeric" placeholder="100.000" placeholderTextColor={theme.colors.mutedForeground} />
        {belowMin && <Text style={s.error}>Minimum top-up is Rp100.000.</Text>}

        {q.quote && (
          <>
            {q.noMethods ? (
              <Text style={s.error}>No payment methods available right now. Try again later.</Text>
            ) : (
              <FiatQuoteBreakdown
                quote={q.quote}
                transferFee={q.transferFee}
                selectedTotalIdr={q.selected?.totalIdr ?? q.quote.totalIdr}
                method={q.method}
                editable
                onMethod={q.setMethod}
              />
            )}
          </>
        )}

        <UIButton
          title={busy ? "Creating…" : q.selected ? `Pay ${fmtIdr(q.selected.totalIdr)}` : "Pay"}
          onPress={createCheckout}
          disabled={busy || !q.quote || belowMin || q.noMethods}
          variant="primary"
        />
        {sync.pending && (
          <View style={styles.pending}>
            <Text style={s.hint}>Complete your payment, then tap Check status — your Saldo updates once the payment is confirmed.</Text>
            <UIButton
              title={sync.syncing ? "Checking…" : "Check payment status"}
              onPress={() => sync.checkStatus(sync.pending!)}
              disabled={sync.syncing}
            />
            <UIButton title="Open payment page" onPress={() => openUrl(sync.pending!.paymentUrl)} />
          </View>
        )}
        {sync.syncMsg && <Text style={s.hint}>{sync.syncMsg}</Text>}
      </View>

      <Text style={s.hint}>
        Minimum top-up {fmtIdr(MIN_NET_IDR.toString())} net. Verified apps pay a Rp0 PeridotID fee. Tap Check payment status after paying — your Saldo updates once confirmed.
      </Text>

      {error && <Text style={s.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  card: {
    marginTop: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    gap: 6,
  },
  pending: { gap: 6 },
});
