import { Text, TouchableOpacity, View } from "../../../shared/primitives";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { ChevronRight } from "../../../shared/icons";
import { styles as s } from "../../../shared/theme";
import { fmtAmount, fmtDate, meta } from "../utils/feed";

export function ChainRow({ tx: t, onSelect }: { tx: WalletTransaction; onSelect: (tx: WalletTransaction) => void }) {
  const m = meta(t);
  const Icon = m.icon;
  return (
    <TouchableOpacity key={t.id} style={s.card} onPress={() => onSelect(t)}>
      <View style={{ flexDirection: "row" }} className="items-center gap-3">
        <View style={{ backgroundColor: m.color + "22" }} className="flex h-9 w-9 items-center justify-center rounded-full">
          <Icon size={16} color={m.color} />
        </View>
        <View className="flex-1 gap-0.5">
          <Text className="font-sans text-[15px] font-semibold text-foreground">{m.label}</Text>
          <Text className="font-sans text-xs text-muted-foreground">{fmtDate(t.createdAt)} · {t.status}</Text>
        </View>
        {t.amount != null && <Text className="font-mono text-sm font-medium text-foreground">{fmtAmount(t)}</Text>}
        <ChevronRight size={16} className="text-muted-foreground" />
      </View>
    </TouchableOpacity>
  );
}
