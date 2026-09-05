import { useCallback, useEffect, useState } from "react";
import { Button, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";

const LAMPORTS_PER_SOL = 1e9;

function fmtAmount(t: WalletTransaction): string {
  if (t.amount == null) return "—";
  const value = Number(t.amount) / (t.asset === "SOL" ? LAMPORTS_PER_SOL : 1e6);
  const sign = t.direction === "in" ? "+" : t.direction === "out" ? "−" : "";
  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${t.asset === "SOL" ? "SOL" : t.asset}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function ActivityDetailScreen({ activityId, onDone }: { activityId: string; onDone: () => void }) {
  const { peridot } = usePeridot();
  const [tx, setTx] = useState<WalletTransaction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await peridot.wallet.transaction(activityId);
      if ("statusCode" in res) throw new Error((res as { message: string }).message);
      setTx(res as WalletTransaction);
    } catch (e) {
      setError(String(e));
    }
  }, [peridot, activityId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!tx && !error) return null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={s.title}>
        {tx?.type === "DEPOSIT" ? "Receive" : tx?.type === "WITHDRAW" ? "Send" : tx?.type === "ACTIVATION" ? "Activation" : "Transaction"}
      </Text>

      {error && <Text style={s.error}>{error}</Text>}
      {!tx && error && <Button title="Back" onPress={onDone} />}

      {tx && (
        <>
          {tx.amount != null && (
            <Text style={styles.bigAmount}>{fmtAmount(tx)}</Text>
          )}

          {tx.type === "ACTIVATION" && (
            <View style={s.card}>
              <Text style={styles.desc}>
                Peridot paid the SOL to create your on-chain smart account (PDA). The
                activation cost — rent + network fee + margin — was reimbursed from your
                wallet to the Peridot treasury in the same transaction.
              </Text>
            </View>
          )}

          <Field label="Status" value={String(tx.status)} />
          <Field label="Type" value={tx.type ?? "—"} />
          <Field label="Amount" value={fmtAmount(tx)} />
          <Field label="Asset" value={tx.asset ?? "—"} />
          <Field label="Counterparty" value={shorten(tx.counterparty)} mono />
          <Field label="Network" value={`${tx.chain} · ${tx.network}`} />
          <Field label="Created" value={fmtDate(tx.createdAt)} />
          <Field label="Confirmed" value={fmtDate(tx.confirmedAt)} />
          {tx.intentId && <Field label="Intent" value={tx.intentId} mono />}

          {tx.txHash && (
            <Button
              title="View on Explorer"
              onPress={() => {
                const cluster = tx.network === "devnet" ? "?cluster=devnet" : "";
                Linking.openURL(`https://explorer.solana.com/tx/${tx.txHash}${cluster}`).catch(() => undefined);
              }}
            />
          )}
          <Button title="Back" onPress={onDone} />
        </>
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

function shorten(v: string | null): string {
  if (!v) return "—";
  return v.length > 24 ? `${v.slice(0, 12)}…${v.slice(-8)}` : v;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 12 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground },
  bigAmount: {
    fontSize: 32,
    fontWeight: "700",
    color: theme.colors.foreground,
    fontFamily: "monospace",
    marginVertical: 8,
  },
  desc: { fontSize: 13, color: theme.colors.mutedForeground, lineHeight: 19 },
  field: { gap: 4 },
  value: { fontSize: 14, color: theme.colors.foreground },
  mono: { fontFamily: "monospace", fontSize: 13 },
});