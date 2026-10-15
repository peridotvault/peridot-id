import { Text, TouchableOpacity, View } from "../../../shared/primitives";
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
  const tone = !posted ? "text-muted-foreground" : incoming ? "text-success" : "text-foreground";
  const amount = tx.amountIdr;
  // Only posted money gets a sign: pending/failed/cancelled moved nothing.
  const sign = posted ? (incoming ? "+" : "−") : "";
  return (
    <TouchableOpacity key={tx.id} style={s.card} onPress={() => onSelect(item)}>
      <View style={{ flexDirection: "row" }} className="items-center gap-3">
        <View style={{ backgroundColor: color + "22" }} className="flex h-9 w-9 items-center justify-center rounded-full">
          <Icon size={16} className={tone} />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="font-sans text-[15px] font-semibold text-foreground">{ledgerLabel(item.kind, incoming)}</Text>
          <Text className="font-sans text-xs text-muted-foreground">{fmtDate(item.createdAt)} · {ledgerStatusLabel(tx.status)}</Text>
        </View>
        <Text className="font-mono text-sm font-medium text-foreground">{sign}{fmtIdr(amount)}</Text>
        <ChevronRight size={16} className="text-muted-foreground" />
      </View>
    </TouchableOpacity>
  );
}
