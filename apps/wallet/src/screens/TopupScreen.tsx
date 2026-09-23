import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "../icons";
import type { CheckoutDepositView, FeePolicyView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";
import { ensureSubAccount } from "../fiat-ensure";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
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

/** Client-side fee preview: flat percent of net, half-up, no floor, no cap. */
function previewFee(net: bigint, policy: FeePolicyView): bigint {
  return (net * BigInt(policy.percentBps) + 5_000n) / 10_000n;
}

/**
 * Deposit into the DOKU Sub-Account (1 PID → 1 User Sub-Account under the
 * `Users` parent). Payments only: enter the NET amount you want credited
 * (minimum Rp100.000), tap Pay, and the DOKU Checkout page opens (all
 * banks, QRIS, e-money, cards). You pay net + the flat 5% platform fee,
 * quoted upfront. After paying, tap Check payment status (auto-checked
 * once on return) — your Saldo updates with the exact quoted net as soon
 * as the payment is confirmed, no waiting for settlement (fiat settlement
 * only backs the balance in the background). The static BRI VA below stays
 * as the always-on rail. DOKU is the ledger.
 */
export function TopupScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [va, setVa] = useState<{ vaNumber: string | null; accountNo: string | null } | null>(null);
  const [policy, setPolicy] = useState<FeePolicyView | null>(null);
  const [noAccount, setNoAccount] = useState(false);
  const [net, setNet] = useState("");
  const [pending, setPending] = useState<CheckoutDepositView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setVa(await peridot.fiat.depositVa());
      setNoAccount(false);
    } catch (e) {
      // Missing row OR a dead creating/failed row — the inline setup below recovers.
      if (/not registered|is creating|is failed/i.test(String(e))) setNoAccount(true);
    }
    try {
      setPolicy(await peridot.fiat.feePolicy());
    } catch {
      // fee preview is a convenience — deposits still work
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const quote = (() => {
    const trimmed = net.replace(/\D/g, "");
    if (!/^\d+$/.test(trimmed) || !policy) return null;
    try {
      const n = BigInt(trimmed);
      if (n <= 0n) return null;
      const fee = previewFee(n, policy);
      return { net: n.toString(), fee: fee.toString(), gross: (n + fee).toString(), belowMin: n < MIN_NET_IDR };
    } catch {
      return null;
    }
  })();

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
      if (tx.providerStatus === "settled") {
        setSyncMsg("Payment confirmed — your Saldo is updated. You can go back.");
        setPending(null);
      } else if (tx.providerStatus === "failed" || tx.providerStatus === "cancelled") {
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
      const trimmed = net.replace(/\D/g, "");
      if (!/^\d+$/.test(trimmed) || BigInt(trimmed) <= 0n) {
        setError("Enter the net amount you want credited.");
        return;
      }
      if (BigInt(trimmed) < MIN_NET_IDR) {
        setError("Minimum top-up is Rp100.000.");
        return;
      }
      const deposit = await peridot.fiat.checkoutDeposit(trimmed);
      setPending(deposit);
      setNet("");
      // Take the user straight to payment — the manual button below remains
      // as fallback when deep-linking is blocked.
      openUrl(deposit.paymentUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Inline fallback for a skipped provisioning run — same path as the stepper. */
  const ensure = async () => {
    setBusy(true);
    setError(null);
    try {
      await ensureSubAccount(peridot);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (noAccount) {
    return (
      <View style={s.container}>
        <TouchableOpacity style={styles.back} onPress={onDone} accessibilityLabel="Back">
          <ArrowLeft size={18} color={theme.colors.foreground} />
          <Text style={styles.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Top Up</Text>
        <Text style={s.subtitle}>Your IDR wallet isn't set up yet — this only happens if provisioning was skipped.</Text>
        {error && <Text style={s.error}>{error}</Text>}
        <UIButton title={busy ? "Setting up…" : "Set up IDR wallet"} onPress={ensure} disabled={busy} variant="primary" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.container}>
      <TouchableOpacity style={styles.back} onPress={onDone} accessibilityLabel="Back">
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>
      <Text style={s.title}>Top Up</Text>
      <Text style={s.subtitle}>Enter what you want credited — you pay that plus the service fee.</Text>

      <View style={styles.card}>
        <Text style={s.label}>Net amount (IDR) — credited to you</Text>
        <TextInput style={s.input} value={groupDigits(net)} onChangeText={(t) => setNet(digitsOnly(t))} keyboardType="numeric" placeholder="100.000" placeholderTextColor={theme.colors.mutedForeground} />
        {quote && (
          <Text style={s.hint}>You receive {fmtIdr(quote.net)} · fee {fmtIdr(quote.fee)}</Text>
        )}
        {quote?.belowMin && (
          <Text style={s.error}>Minimum top-up is Rp100.000.</Text>
        )}
        <UIButton
          title={busy ? "Creating…" : quote ? `Pay IDR ${Number(quote.gross).toLocaleString("id-ID")}` : "Pay"}
          onPress={createCheckout}
          disabled={busy || !quote || quote.belowMin}
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

      {va?.vaNumber && (
        <View style={styles.card}>
          <Text style={s.label}>Or deposit via BRI Virtual Account (real-time)</Text>
          <Text style={styles.va} selectable>{va.vaNumber}</Text>
          <Text style={s.hint}>Transfer from any bank. VA credits are preserved as received; ones below the Rp100.000 net minimum are flagged for review, not treated as top-ups.</Text>
        </View>
      )}

      {policy && (
        <Text style={s.hint}>
          Service fee {policy.percentBps / 100}% flat of the credited amount, no cap. Minimum top-up {fmtIdr(MIN_NET_IDR.toString())} net. Tap Check payment status after paying — your Saldo updates once confirmed.
        </Text>
      )}

      {error && <Text style={s.error}>{error}</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  va: { fontSize: 22, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.mono },
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
