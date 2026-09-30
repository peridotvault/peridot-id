import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowDownLeft, ArrowUpRight, ChevronRight } from "../../../shared/icons";
import { theme, styles as s } from "../../../shared/theme";
import type { FiatItem } from "../../../shared/fiat";
import { fiatStatusLabel, fmtIdr } from "../../../shared/fiat";
import { fiatLabel, fmtDate } from "../utils/feed";

export function FiatRow({ item, onSelect }: { item: FiatItem; onSelect: (item: FiatItem) => void }) {
  const incoming = item.kind === "deposit";
  const { tx } = item;
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const color = tx.providerStatus === "settled" || tx.providerStatus === "success" ? theme.colors.success : theme.colors.foreground;
  // Only live money gets a sign: failed/cancelled/expired moved nothing.
  const live = ["settled", "success", "processing", "created"].includes(tx.providerStatus);
  const sign = live ? (incoming ? "+" : "−") : "";
  // Fee rows move the fee, not the parent gross — show what actually moved.
  // Headline rule everywhere: show NET (what the user gets), fall back to
  // gross while unsettled.
  const moved = item.kind === "fee" ? (tx.feeIdr ?? tx.grossIdr) : (tx.netIdr ?? tx.grossIdr);
  return (
    <TouchableOpacity key={tx.id} style={s.card} onPress={() => onSelect(item)}>
      <View style={styles.row}>
        <View style={[styles.icon, { backgroundColor: color + "22" }]}>
          <Icon size={16} color={color} />
        </View>
        <View style={styles.meta}>
          <Text style={styles.label}>{fiatLabel(item.kind)}</Text>
          <Text style={styles.muted}>{fmtDate(item.createdAt)} · {fiatStatusLabel(item.kind, tx.providerStatus)}</Text>
        </View>
        <Text style={styles.amount}>{sign}{fmtIdr(moved)}</Text>
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
