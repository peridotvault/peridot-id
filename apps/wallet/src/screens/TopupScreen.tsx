import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "../icons";
import type { CheckoutDepositView, DepositQuoteView } from "@peridotvault/pid-sdk-js";
import { sumTransferFee } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

/** Sum two whole-IDR strings (PPN folded into the shown fee lines). */
function sumIdr(a: string, b: string): string {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

/** Max input digits (Checkout order.amount is an integer ≤12 digits). */
const MAX_INPUT_DIGITS = 12;

/** Minimum Checkout top-up, NET IDR (mirrors the API; the API rejects below). */
const MIN_NET_IDR = 100_000n;

/** Keep digits only (paste-safe), strip leading zeros, cap length. */
function digitsOnly(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  return digits.slice(0, MAX_INPUT_DIGITS);
}

/** Group digits id-ID for display: "100000" → "100.000". Empty stays empty. */
function groupDigits(digits: string): string {
  if (!digits) return "";
  return Number(digits).toLocaleString("id-ID");
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && styles.strong]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

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
  const [quote, setQuote] = useState<DepositQuoteView | null>(null);
  const [method, setMethod] = useState<string | null>(null);
  const [pending, setPending] = useState<CheckoutDepositView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  // Quote the top-up (moves no money) once the user pauses on a valid amount.
  useEffect(() => {
    const trimmed = net.replace(/\D/g, "");
    if (!/^\d+$/.test(trimmed) || BigInt(trimmed) < MIN_NET_IDR) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      const n = BigInt(trimmed);
      peridot.fiat
        .quoteDeposit({ netAmountIdr: n.toString() })
        .then((q) => {
          if (cancelled) return;
          setQuote(q);
          setMethod((m) => (m && q.paymentMethods.some((p) => p.key === m) ? m : q.paymentMethods[0]?.key ?? null));
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [net, peridot]);

  const selected = quote?.paymentMethods.find((p) => p.key === method) ?? null;
  const noMethods = !!quote && quote.paymentMethods.length === 0;
  // One combined fee line: PeridotID (fee+PPN) + DOKU gateway (fee+PPN).
  const transferFee = quote ? quote.transferFeeIdr ?? sumTransferFee(quote) : "0";
  const digits = net.replace(/\D/g, "");
  const belowMin = /^\d+$/.test(digits) && BigInt(digits) > 0n && BigInt(digits) < MIN_NET_IDR;

  const openUrl = (url: string) => {
    Linking.openURL(url).catch(() => setError("Could not open the payment page."));
  };

  /**
   * Check a pending deposit against DOKU and unlock the Saldo when paid.
   * Webhooks cannot reach local dev (and may lag in prod), so the wallet
   * corroborates on demand — same server-side path as the webhook, never
   * trust-based. Safe to tap repeatedly; duplicate checks are no-ops.
   */
  const checkStatus = useCallback(async (intent: CheckoutDepositView) => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const tx = await peridot.fiat.syncTransaction(intent.id);
      if (tx.providerStatus === "settled" || tx.providerStatus === "success") {
        setSyncMsg("Payment confirmed — your Saldo is updated. You can go back.");
        setPending(null);
      } else if (["failed", "cancelled", "expired"].includes(tx.providerStatus)) {
        setSyncMsg("This payment did not go through — no money moved. You can try again.");
        setPending(null);
      } else {
        setSyncMsg("Still waiting for your bank transfer — check status again in a bit.");
      }
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [peridot]);

  // Auto-check once when returning from the payment page with a fresh intent:
  // the user just paid (or abandoned), so corroborate without making them dig.
  const autoSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pending || autoSyncedRef.current === pending.id) return;
    autoSyncedRef.current = pending.id;
    void checkStatus(pending);
  }, [pending, checkStatus]);

  const createCheckout = async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    try {
      if (!/^\d+$/.test(digits) || BigInt(digits) <= 0n) {
        setError("Enter the net amount you want credited.");
        return;
      }
      if (BigInt(digits) < MIN_NET_IDR) {
        setError("Minimum top-up is Rp100.000.");
        return;
      }
      if (!method) {
        setError("No payment methods available right now.");
        return;
      }
      const deposit = await peridot.fiat.checkoutDeposit(digits, undefined, method);
      setPending(deposit);
      setNet("");
      setQuote(null);
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

        {quote && (
          <>
            {noMethods ? (
              <Text style={s.error}>No payment methods available right now. Try again later.</Text>
            ) : (
              <>
                <Text style={s.label}>Payment method</Text>
                <View style={styles.methods}>
                  {quote.paymentMethods.map((m) => (
                    <TouchableOpacity
                      key={m.key}
                      style={[styles.method, method === m.key && styles.methodActive]}
                      onPress={() => setMethod(m.key)}
                      accessibilityLabel={`Pay with ${m.label}`}
                    >
                      <Text style={[styles.methodLabel, method === m.key && styles.methodLabelActive]}>{m.label}</Text>
                      {m.enabled && <Text style={styles.methodFee}>{fmtIdr(sumIdr(m.gatewayFeeIdr, m.gatewayTaxIdr))}</Text>}
                    </TouchableOpacity>
                  ))}
                </View>

                <View style={styles.breakdown}>
                  <Row label="Amount" value={fmtIdr(quote.netIdr)} />
                  {BigInt(transferFee) > 0n && <Row label="Transfer Fee" value={fmtIdr(transferFee)} />}
                  {Number(quote.appFeeIdr) > 0 && <Row label="App Fee" value={fmtIdr(quote.appFeeIdr)} />}
                  <Row label="Total Payment" value={fmtIdr(selected?.totalIdr ?? quote.totalIdr)} strong />
                </View>
              </>
            )}
          </>
        )}

        <UIButton
          title={busy ? "Creating…" : selected ? `Pay ${fmtIdr(selected.totalIdr)}` : "Pay"}
          onPress={createCheckout}
          disabled={busy || !quote || belowMin || noMethods}
          variant="primary"
        />
        {pending && (
          <View style={styles.pending}>
            <Text style={s.hint}>Complete your payment, then tap Check status — your Saldo updates once the payment is confirmed.</Text>
            <UIButton
              title={syncing ? "Checking…" : "Check payment status"}
              onPress={() => checkStatus(pending)}
              disabled={syncing}
            />
            <UIButton title="Open payment page" onPress={() => openUrl(pending.paymentUrl)} />
          </View>
        )}
        {syncMsg && <Text style={s.hint}>{syncMsg}</Text>}
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
  methods: { gap: 6, marginTop: 2 },
  method: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  methodActive: { borderColor: theme.colors.foreground },
  methodLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  methodLabelActive: { fontWeight: "600" },
  methodFee: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.mono },
  breakdown: { marginTop: 8, gap: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowLabel: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  rowValue: { fontSize: 13, color: theme.colors.foreground, fontFamily: theme.fonts.mono },
  strong: { fontWeight: "700", color: theme.colors.foreground },
});
