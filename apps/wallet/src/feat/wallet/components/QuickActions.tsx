import { Text, TouchableOpacity, View } from "../../../shared/primitives";
import { ArrowDownLeft, ArrowUpRight, Banknote, Coins } from "../../../shared/icons";

export function QuickActions({
  onSend,
  onReceive,
  onSwap,
  onBuy,
}: {
  onSend: () => void;
  onReceive: () => void;
  onSwap: () => void;
  onBuy: () => void;
}) {
  return (
    <View style={{ flexDirection: "row" }} className="gap-3">
      <ActionButton icon={ArrowUpRight} label="Send" onPress={onSend} />
      <ActionButton icon={ArrowDownLeft} label="Receive" onPress={onReceive} />
      <ActionButton icon={Coins} label="Swap" onPress={onSwap} />
      <ActionButton icon={Banknote} label="Buy" onPress={onBuy} />
    </View>
  );
}

function ActionButton({ icon: Icon, label, onPress, disabled }: { icon: typeof ArrowUpRight; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled }}
      className="flex-1"
    >
      <View className={`w-full items-center gap-2 border border-border bg-surface py-3 ${disabled ? "opacity-40" : ""}`}>
        <View className="h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Icon size={20} className={disabled ? "text-muted-foreground" : "text-foreground"} />
        </View>
        <Text className={`font-sans text-[13px] font-medium text-foreground ${disabled ? "opacity-60" : ""}`}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}
