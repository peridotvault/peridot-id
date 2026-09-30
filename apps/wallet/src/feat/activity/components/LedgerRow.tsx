import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from "../../../shared/icons";
import { theme, styles as s } from "../../../shared/theme";
import type { FiatLedgerItem } from "../../../shared/fiat";
import { fmtIdr, ledgerStatusLabel } from "../../../shared/fiat";
import { fmtDate, ledgerLabel } from "../utils/feed";

export function LedgerRow({ item, onSelect }: { item: FiatLedgerItem; onSelect: (item: FiatLedgerItem) => void }) {
  const { tx } = item;
  const incoming = tx.direction === "in";
  const posted = tx.status === "posted";
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const color = posted ? (incoming ? theme.colors.success : theme.colors.foreground) : theme.colors.mutedForeground;
  const amount = tx.amountIdr;
  // Only posted money gets a sign: pending/failed/cancelled moved nothing.
  const sign = posted ? (incoming ? "+" : "−") : "";
  return (
    <TouchableOpacity key={tx.id} style={s.card} onPress={() => onSelect(item)}>
      <View style={styles.row}>
        <View style={[styles.icon, { backgroundColor: color + "22" }]}>
          <Icon size={16} color={color} />
        </View>
        <View style={styles.meta}>
          <Text style={styles.label}>{ledgerLabel(item.kind, incoming)}</Text>
          <Text style={styles.muted}>{fmtDate(item.createdAt)} · {ledgerStatusLabel(tx.status)}</Text>
        </View>
        <Text style={styles.amount}>{sign}{fmtIdr(amount)}</Text>
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  meta: { flex: 1, gap: 2 },
  label: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  muted: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  amount: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.mono },
});
