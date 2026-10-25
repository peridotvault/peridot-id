import { Pressable } from "../../../shared/components/ui/Pressable";
import { ArrowDownLeft, ArrowUpRight, Banknote, Coins } from "../../../shared/components/icons";

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
    <div style={{ flexDirection: "row" }} className="flex flex-col gap-3">
      <ActionButton icon={ArrowUpRight} label="Send" onPress={onSend} />
      <ActionButton icon={ArrowDownLeft} label="Receive" onPress={onReceive} />
      <ActionButton icon={Coins} label="Swap" onPress={onSwap} />
      <ActionButton icon={Banknote} label="Buy" onPress={onBuy} />
    </div>
  );
}

function ActionButton({ icon: Icon, label, onPress, disabled }: { icon: typeof ArrowUpRight; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled }}
      className="flex-1"
    >
      <div className={`flex flex-col w-full items-center gap-2 border border-border bg-surface py-3 ${disabled ? "opacity-40" : ""}`}>
        <div className="flex flex-col h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Icon size={20} className={disabled ? "text-muted-foreground" : "text-foreground"} />
        </div>
        <span className={`font-sans text-sm font-medium text-foreground ${disabled ? "opacity-60" : ""}`}>{label}</span>
      </div>
    </Pressable>
  );
}
