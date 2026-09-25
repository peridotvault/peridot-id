import { useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "../icons";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";
import type { FiatItem } from "./ActivityScreen";
import { fiatStatusLabel } from "./ActivityScreen";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** A DOKU Checkout deposit intent (money-in). Once paid it disappears from
 *  here and appears on the fiat ledger as a fiat_issue entry. */
export function FiatDetailScreen({ item: initial, onDone }: { item: FiatItem; onDone: () => void }) {
  const { peridot } = usePeridot();
  const [item, setItem] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tx } = item;
  const awaitingPayment = tx.providerStatus === "created";

  const sync = async () => {
    setChecking(true);
    setError(null);
    try {
      const fresh = await peridot.fiat.syncTransaction(tx.id);
      setItem({ kind: "deposit", createdAt: fresh.createdAt, tx: fresh });
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

      <Text style={s.title}>Deposit</Text>
      <Text style={styles.bigAmount}>{fmtIdr(tx.netIdr ?? tx.grossIdr)}</Text>

      {awaitingPayment && (
        <View style={s.card}>
          <Text style={styles.desc}>Waiting for payment — complete it, then come back and check status.</Text>
          {tx.paymentUrl && (
            <UIButton
              title="Open DOKU payment page"
              onPress={() => Linking.openURL(tx.paymentUrl as string).catch(() => setError("Could not open the DOKU payment page."))}
              variant="primary"
            />
          )}
        </View>
      )}

      <Field label="Status" value={fiatStatusLabel(item.kind, tx.providerStatus)} />
      {tx.feeIdr && <Field label="Service fee" value={fmtIdr(tx.feeIdr)} />}
      <Field label="Created" value={fmtDate(item.createdAt)} />

      {error && <Text style={s.error}>{error}</Text>}

      {(awaitingPayment || tx.providerStatus === "processing") && (
        <UIButton title={checking ? "Checking…" : "Check status"} onPress={sync} disabled={checking} />
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
});
