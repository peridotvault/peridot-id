import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { TopupView, WithdrawView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function FiatHistoryScreen({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [balance, setBalance] = useState<string | null>(null);
  const [topups, setTopups] = useState<TopupView[]>([]);
  const [withdraws, setWithdraws] = useState<WithdrawView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [wAmount, setWAmount] = useState("");
  const [wBank, setWBank] = useState("");
  const [wAccount, setWAccount] = useState("");
  const [wName, setWName] = useState("");
  const [wBusy, setWBusy] = useState(false);
  const [wError, setWError] = useState<string | null>(null);
  const [wOk, setWOk] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [b, t, w] = await Promise.all([peridot.fiat.balance(), peridot.fiat.topups(), peridot.fiat.withdraws()]);
      setBalance(b.availableIdr);
      setTopups(t);
      setWithdraws(w);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const requestWithdraw = async () => {
    setWBusy(true);
    setWError(null);
    setWOk(false);
    try {
      const trimmed = wAmount.replace(/\D/g, "");
      if (!/^\d+$/.test(trimmed) || BigInt(trimmed) < 10_000n) {
        setWError("Minimum withdraw is Rp10.000.");
        return;
      }
      await peridot.fiat.requestWithdraw(trimmed, {
        ...(wBank ? { bankCode: wBank } : {}),
        ...(wAccount ? { accountNumber: wAccount } : {}),
        ...(wName ? { accountName: wName } : {}),
      });
      setWOk(true);
      setWAmount("");
      load();
    } catch (e) {
      setWError(String(e));
    } finally {
      setWBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={s.container}>
      <Text style={s.title}>IDR History</Text>
      <Text style={s.subtitle}>Fiat top-ups and withdraw requests. {busy ? "Loading…" : ""}</Text>
      {balance !== null && (
        <View style={styles.balanceBlock}>
          <Text style={styles.balance}>{fmtIdr(balance)}</Text>
          <Text style={styles.balanceLabel}>Available IDR balance</Text>
        </View>
      )}
      {error && <Text style={s.error}>{error}</Text>}

      <Text style={styles.sectionLabel}>Withdraw IDR</Text>
      <Text style={s.hint}>Manual settlement for now — requests stay pending until processed.</Text>
      <Text style={s.label}>Amount (IDR)</Text>
      <TextInput style={s.input} value={wAmount} onChangeText={setWAmount} keyboardType="numeric" placeholder="50000" placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.label}>Bank code (optional)</Text>
      <TextInput style={s.input} value={wBank} onChangeText={setWBank} autoCapitalize="characters" placeholder="BCA" placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.label}>Account number (optional)</Text>
      <TextInput style={s.input} value={wAccount} onChangeText={setWAccount} keyboardType="numeric" placeholder="1234567890" placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.label}>Account name (optional)</Text>
      <TextInput style={s.input} value={wName} onChangeText={setWName} placeholder="Nama pemilik" placeholderTextColor={theme.colors.mutedForeground} />
      {wError && <Text style={s.error}>{wError}</Text>}
      {wOk && <Text style={styles.ok}>Request recorded — status pending.</Text>}
      <UIButton title={wBusy ? "Sending…" : "Request withdraw"} onPress={requestWithdraw} disabled={wBusy} />

      <Text style={styles.sectionLabel}>Top-ups</Text>
      {topups.length === 0 && !busy && <Text style={s.hint}>No top-ups yet.</Text>}
      {topups.map((t) => (
        <View key={t.id} style={styles.row}>
          <View style={styles.rowMeta}>
            <Text style={styles.rowAmount}>{fmtIdr(t.amountIdr)}</Text>
            <Text style={styles.rowSub}>{t.invoiceNumber} · {fmtDate(t.createdAt)}</Text>
          </View>
          <StatusChip status={t.status} />
        </View>
      ))}

      <Text style={styles.sectionLabel}>Withdraws</Text>
      {withdraws.length === 0 && !busy && <Text style={s.hint}>No withdraw requests yet.</Text>}
      {withdraws.map((w) => (
        <View key={w.id} style={styles.row}>
          <View style={styles.rowMeta}>
            <Text style={styles.rowAmount}>{fmtIdr(w.amountIdr)}</Text>
            <Text style={styles.rowSub}>{fmtDate(w.createdAt)}</Text>
          </View>
          <StatusChip status={w.status} />
        </View>
      ))}

      <UIButton title="Refresh" onPress={load} disabled={busy} />
      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}

function StatusChip({ status }: { status: string }) {
  const good = status === "paid" || status === "settled";
  const bad = status === "failed" || status === "expired" || status === "rejected";
  return (
    <View style={styles.chip}>
      <Text style={[styles.chipText, good && styles.good, bad && styles.bad]}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  balanceBlock: { gap: 2, marginTop: 4 },
  balance: { fontSize: 32, fontWeight: "400", color: theme.colors.foreground, fontFamily: theme.fonts.serif },
  balanceLabel: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  sectionLabel: {
    fontSize: 12,
    color: theme.colors.mutedForeground,
    fontWeight: "600",
    fontFamily: theme.fonts.sansSemiBold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 8,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowMeta: { flex: 1, gap: 2 },
  rowAmount: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  rowSub: { fontSize: 11, color: theme.colors.mutedForeground, fontFamily: theme.fonts.mono },
  chip: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipText: { fontSize: 11, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sansMedium },
  good: { color: theme.colors.success },
  bad: { color: theme.colors.danger },
  ok: { color: theme.colors.success, fontSize: 13, fontFamily: theme.fonts.sans },
});
