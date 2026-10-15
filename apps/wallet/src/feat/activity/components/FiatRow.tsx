import { Text, TouchableOpacity, View } from "../../../shared/primitives";
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
  const tinted = color === theme.colors.success;
  // Only live money gets a sign: failed/cancelled/expired moved nothing.
  const live = ["settled", "success", "processing", "created"].includes(tx.providerStatus);
  const sign = live ? (incoming ? "+" : "−") : "";
  // Fee rows move the fee, not the parent gross — show what actually moved.
  // Headline rule everywhere: show NET (what the user gets), fall back to
  // gross while unsettled.
  const moved = item.kind === "fee" ? (tx.feeIdr ?? tx.grossIdr) : (tx.netIdr ?? tx.grossIdr);
  return (
    <TouchableOpacity key={tx.id} style={s.card} onPress={() => onSelect(item)}>
      <View style={{ flexDirection: "row" }} className="items-center gap-3">
        <View style={{ backgroundColor: color + "22" }} className="flex h-9 w-9 items-center justify-center rounded-full">
          <Icon size={16} className={tinted ? "text-success" : "text-foreground"} />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="font-sans text-[15px] font-semibold text-foreground">{fiatLabel(item.kind)}</Text>
          <Text className="font-sans text-xs text-muted-foreground">{fmtDate(item.createdAt)} · {fiatStatusLabel(item.kind, tx.providerStatus)}</Text>
        </View>
        <Text className="font-mono text-sm font-medium text-foreground">{sign}{fmtIdr(moved)}</Text>
        <ChevronRight size={16} className="text-muted-foreground" />
      </View>
    </TouchableOpacity>
  );
}
