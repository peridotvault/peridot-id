import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { ChevronRight } from "../../../shared/icons";
import { theme, styles as s } from "../../../shared/theme";
import { fmtAmount, fmtDate, meta } from "../utils/feed";

export function ChainRow({ tx: t, onSelect }: { tx: WalletTransaction; onSelect: (tx: WalletTransaction) => void }) {
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
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  meta: { flex: 1, gap: 2 },
  label: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  muted: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  amount: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.mono },
});
