import { Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "../icons";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

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

export function ActivityDetailScreen({ tx, onDone }: { tx: WalletTransaction; onDone: () => void }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <Text style={s.title}>
        {tx.type === "DEPOSIT" ? "Receive" : tx.type === "WITHDRAW" ? "Send" : tx.type === "ACTIVATION" ? "Activation" : "Transaction"}
      </Text>

      {tx.amount != null && <Text style={styles.bigAmount}>{fmtAmount(tx)}</Text>}

      {tx.type === "ACTIVATION" && (
        <View style={s.card}>
          <Text style={styles.desc}>
            Peridot paid the SOL to create your on-chain smart account (PDA). The activation
            cost — rent + network fee + margin — was reimbursed from your wallet to the
            Peridot treasury in the same transaction.
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

      {tx.txHash && (
        <UIButton
          title="View on Explorer"
          onPress={() => {
            const cluster = tx.network === "devnet" ? "?cluster=devnet" : "";
            Linking.openURL(`https://explorer.solana.com/tx/${tx.txHash}${cluster}`).catch(() => undefined);
          }}
          variant="primary"
        />
      )}
      <UIButton title="Back" onPress={onDone} />
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