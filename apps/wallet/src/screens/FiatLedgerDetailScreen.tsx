import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "../icons";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";
import type { FiatLedgerItem } from "./ActivityScreen";
import { ledgerStatusLabel } from "./ActivityScreen";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

function titleOf(item: FiatLedgerItem, incoming: boolean): string {
  if (item.kind === "deposit") return "Deposit";
  if (item.kind === "adjust") return "Adjustment";
  return incoming ? "Transfer in" : "Transfer out";
}

/** Immutable fiat ledger entry. Read-only except a
 *  not-yet-posted outgoing transfer, which can be cancelled. */
export function FiatLedgerDetailScreen({ item: initial, onDone }: { item: FiatLedgerItem; onDone: () => void }) {
  const { peridot } = usePeridot();
  const [item, setItem] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tx } = item;
  const incoming = tx.direction === "in";
  const posted = tx.status === "posted";
  const sign = posted ? (incoming ? "+" : "−") : "";
  const amount = tx.amountIdr;
  const cancellable = tx.status === "created" && tx.kind === "fiat_transfer_out";

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const fresh = await peridot.fiat.cancelTransaction(tx.id);
      setItem({ ...item, tx: fresh });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={s.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={s.title}>{titleOf(item, incoming)}</Text>
      <Text style={styles.bigAmount}>{sign}{fmtIdr(amount)}</Text>

      <Field label="Status" value={ledgerStatusLabel(tx.status)} />
      {tx.counterpartyPid && <Field label={incoming ? "From" : "To"} value={tx.counterpartyPid} />}
      <Field label={incoming ? "Credited" : "Debited"} value={fmtIdr(tx.amountIdr)} />
      <Field label="Reference" value={tx.entryGroup} />
      <Field label="Created" value={fmtDate(item.createdAt)} />

      {error && <Text style={s.error}>{error}</Text>}

      {cancellable && (
        <UIButton title={busy ? "Cancelling…" : "Cancel transfer"} onPress={cancel} disabled={busy} variant="danger" />
      )}
    </ScrollView>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={s.label}>{label}</Text>
      <Text style={styles.value} selectable>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  bigAmount: {
    fontSize: 32,
    fontWeight: "400",
    color: theme.colors.foreground,
    fontFamily: theme.fonts.serif,
    marginVertical: 8,
  },
  field: { gap: 4 },
  value: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
});
