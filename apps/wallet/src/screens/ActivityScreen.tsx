import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowDownLeft, ArrowUpRight, Rocket, ChevronRight, RefreshCw } from "../icons";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

const LAMPORTS_PER_SOL = 1e9;

function fmtAmount(t: WalletTransaction): string {
  if (t.amount == null) return "";
  const asset = t.asset === "SOL" ? "SOL" : t.asset;
  const value = Number(t.amount) / (t.asset === "SOL" ? LAMPORTS_PER_SOL : 1e6);
  const sign = t.direction === "in" ? "+" : t.direction === "out" ? "−" : "";
  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${asset}`;
}

function meta(t: WalletTransaction): { label: string; icon: typeof ArrowUpRight; color: string } {
  switch (t.type) {
    case "DEPOSIT":
      return { label: "Receive", icon: ArrowDownLeft, color: theme.colors.success };
    case "WITHDRAW":
      return { label: "Send", icon: ArrowUpRight, color: theme.colors.foreground };
    case "ACTIVATION":
      return { label: "Activation", icon: Rocket, color: theme.colors.foreground };
    default:
      return { label: "Transaction", icon: RefreshCw, color: theme.colors.mutedForeground };
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ActivityScreen({
  onSelect,
}: {
  onSelect: (tx: WalletTransaction) => void;
}) {
  const { peridot } = usePeridot();
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await peridot.wallet.history();
      setItems((Array.isArray(res) ? res : []) as WalletTransaction[]);
    } catch (e) {
      setError(String(e));
      // Non-fatal: keep showing cached local history if the RPC is unreachable.
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <View style={styles.headRow}>
        <Text style={s.title}>Activity</Text>
        <TouchableOpacity style={styles.iconBtn} onPress={load} disabled={busy}>
          <RefreshCw size={16} color={theme.colors.foreground} />
        </TouchableOpacity>
      </View>

      {error && <Text style={s.error}>{error}</Text>}
      {busy && <Text style={s.hint}>Loading…</Text>}

      {items.length === 0 && !busy && (
        <Text style={s.hint}>No activity yet — send, receive, or activate your account to get started.</Text>
      )}

      {items.map((t) => {
        const m = meta(t);
        const Icon = m.icon;
        return (
          <TouchableOpacity key={t.id} style={s.card} onPress={() => onSelect(t)}>
            <View style={styles.row}>
              <View style={[styles.icon, { backgroundColor: m.color + "22" }]}>
                <Icon size={16} color={m.color} />
              </View>
              <View style={styles.meta}>
                <Text style={styles.label}>{m.label}</Text>
                <Text style={styles.muted}>{fmtDate(t.createdAt)} · {t.status}</Text>
              </View>
              {t.amount != null && <Text style={styles.amount}>{fmtAmount(t)}</Text>}
              <ChevronRight size={16} color={theme.colors.mutedForeground} />
            </View>
          </TouchableOpacity>
        );
      })}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 12 },
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  meta: { flex: 1, gap: 2 },
  label: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  muted: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  amount: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.mono },
});