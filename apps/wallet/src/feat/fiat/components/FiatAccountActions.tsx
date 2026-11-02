import { Pressable } from "../../../shared/components/ui/Pressable";
import { ArrowDownLeft, ArrowUpRight, Banknote, Plus } from "../../../shared/components/icons";

// Rupiah account actions. Send/Top Up route to the existing overlays;
// Receive/Withdraw stay disabled until the ledger API supports them.
export function FiatAccountActions({ onSend, onTopup }: { onSend: () => void; onTopup: () => void }) {
  return (
    <div className="grid grid-cols-4 gap-2 border-t border-line px-6 py-4">
      <Action icon={ArrowUpRight} label="Send" onPress={onSend} />
      <Action icon={ArrowDownLeft} label="Receive" disabled note="Soon" />
      <Action icon={Plus} label="Top Up" onPress={onTopup} />
      <Action icon={Banknote} label="Withdraw" disabled note="Soon" />
    </div>
  );
}

function Action({
  icon: Icon,
  label,
  onPress,
  disabled,
  note,
}: {
  icon: typeof ArrowUpRight;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  note?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled }}
      accessibilityLabel={disabled ? `${label}, coming soon` : label}
    >
      <div
        className={`flex aspect-square w-full flex-col items-center justify-center gap-2 border border-border bg-background transition-colors hover:bg-surface ${disabled ? "opacity-40" : ""}`}
      >
        <Icon size={22} className="text-accent" />
        <span className="font-sans text-sm font-medium text-foreground">{label}</span>
        {note ? <span className="font-sans text-xs text-muted-foreground">{note}</span> : null}
      </div>
    </Pressable>
  );
}
