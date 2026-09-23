import { useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "../icons";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";
import type { FiatItem } from "./ActivityScreen";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

const TITLES: Record<FiatItem["kind"], string> = {
  deposit: "Deposit",
  withdraw: "Withdraw",
  transfer: "Transfer",
  debit: "Debit",
  fee: "Service fee",
};

export function FiatDetailScreen({ item: initial, onDone }: { item: FiatItem; onDone: () => void }) {
  const { peridot } = usePeridot();
  const [item, setItem] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tx } = item;
  const incoming = item.kind === "deposit";
  const sign = incoming ? "+" : "−";
  // Headline rule: NET (what the user gets), gross while unsettled.
  // Fee rows (reachable only via legacy links) show the fee moved.
  const moved = item.kind === "fee" ? (tx.feeIdr ?? tx.grossIdr) : (tx.netIdr ?? tx.grossIdr);
  const awaitingPayment = incoming && tx.providerStatus === "created";
  const syncable = tx.providerStatus === "created" || tx.providerStatus === "processing";
  const retryable = (item.kind === "withdraw" || item.kind === "transfer") && tx.providerStatus === "failed";
  const cancellable = tx.providerStatus === "created";
  // No fee-settlement affordance: DOKU settles NET → user + FEE → Treasury
  // natively. The fee below is the honored quote snapshot, read-only.

  const sync = async () => {
    setChecking(true);
    setError(null);
    try {
      const fresh = await peridot.fiat.syncTransaction(tx.id);
      setItem({ kind: item.kind, createdAt: fresh.createdAt, tx: fresh });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const retry = async () => {
    setChecking(true);
    setError(null);
    try {
      const fresh = await peridot.fiat.retryTransfer(tx.id);
      setItem({ kind: item.kind, createdAt: fresh.createdAt, tx: fresh });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const cancel = async () => {
    setChecking(true);
    setError(null);
    try {
      const fresh = await peridot.fiat.cancelTransaction(tx.id);
      setItem({ kind: item.kind, createdAt: fresh.createdAt, tx: fresh });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={s.title}>{TITLES[item.kind]}</Text>
      <Text style={styles.bigAmount}>{sign}{fmtIdr(moved)}</Text>

      {!incoming && tx.providerStatus === "created" && (
        <View style={s.card}>
          <Text style={styles.desc}>Transfer inquiry created — confirm it to move the money.</Text>
        </View>
      )}
      {awaitingPayment && (
        <View style={s.card}>
          <Text style={styles.desc}>Waiting for payment — complete it on the DOKU page, then come back and check status.</Text>
          {tx.paymentUrl && (
            <UIButton
              title="Open DOKU payment page"
              onPress={() => Linking.openURL(tx.paymentUrl as string).catch(() => setError("Could not open the DOKU payment page."))}
              variant="primary"
            />
          )}
        </View>
      )}
      {tx.providerStatus === "processing" && (
        <View style={s.card}>
          <Text style={styles.desc}>Sent to DOKU — check status until it settles or fails.</Text>
        </View>
      )}

      <Field label="Status" value={tx.providerStatus} />
      <Field label="Reference" value={tx.providerRef} mono />
      {tx.feeIdr && <Field label="Service fee" value={fmtIdr(tx.feeIdr)} />}
      <Field label="Created" value={fmtDate(item.createdAt)} />

      {error && <Text style={s.error}>{error}</Text>}

      {syncable && <UIButton title={checking ? "Checking…" : "Check status"} onPress={sync} disabled={checking} />}
      {retryable && <UIButton title={checking ? "Retrying…" : "Retry"} onPress={retry} disabled={checking} variant="primary" />}
      {cancellable && (
        <UIButton title={checking ? "Cancelling…" : "Cancel"} onPress={cancel} disabled={checking} variant="danger" />
      )}
    </ScrollView>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={s.label}>{label}</Text>
      <Text style={[styles.value, mono && styles.mono]} selectable>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 12 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  bigAmount: {
    fontSize: 32,
    fontWeight: "400",
    color: theme.colors.foreground,
    fontFamily: theme.fonts.serif,
    marginVertical: 8,
  },
  desc: { fontSize: 13, color: theme.colors.mutedForeground, lineHeight: 19, fontFamily: theme.fonts.sans },
  field: { gap: 4 },
  value: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  mono: { fontFamily: theme.fonts.mono, fontSize: 13 },
});
