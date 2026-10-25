import { Pressable } from "../../../shared/components/Pressable";
import { ArrowDownLeft, ArrowUpRight, Banknote, Plus } from "../../../shared/icons";

// Rupiah account actions. Send/Top Up route to the existing overlays;
// Receive/Withdraw stay disabled until the ledger API supports them.
export function FiatAccountActions({ onSend, onTopup }: { onSend: () => void; onTopup: () => void }) {
  return (
    <div style={{ flexDirection: "row" }} className="flex flex-col gap-3">
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
      className="flex-1"
    >
      <div className={`flex flex-col w-full items-center gap-2 border border-border bg-surface py-3 ${disabled ? "opacity-40" : ""}`}>
        <div className="flex flex-col h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Icon size={20} className="text-foreground" />
        </div>
        <span className="font-sans text-sm font-medium text-foreground">{label}</span>
        {note ? <span className="font-sans text-xs text-muted-foreground">{note}</span> : null}
      </div>
    </Pressable>
  );
}
