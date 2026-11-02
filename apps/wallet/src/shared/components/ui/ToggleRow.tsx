import { Pressable } from "./Pressable";
import { Check } from "../icons";

// On/off setting row: icon, label, hint, and a square ON/OFF chip. One control
// primitive so Settings and the Chains page can't drift apart.
export function ToggleRow({
  icon: Icon,
  label,
  hint,
  on,
  busy,
  testnet,
  onPress,
  className = "px-6",
}: {
  icon: typeof Check;
  label: string;
  hint: string;
  on: boolean;
  busy?: boolean;
  testnet?: boolean;
  onPress: () => void;
  className?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={testnet ? `${label} (testnet)` : label}
    >
      <div className={`flex w-full items-center gap-3 py-3 transition-colors hover:bg-surface ${className}`}>
        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-line bg-surface">
          <Icon size={18} className="text-foreground" />
        </div>
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="font-sans text-base font-medium text-foreground">{label}</span>
          <span className="font-sans text-xs text-muted-foreground">{hint}</span>
        </div>
        {testnet && <span className="font-sans text-xs font-bold tracking-[1px] text-muted-foreground">TESTNET</span>}
        <div className={`flex items-center gap-1 border px-2.5 py-1.5 ${on ? "border-foreground" : "border-border"}`}>
          {on && <Check size={14} className="text-foreground" />}
          <span className={`font-sans text-sm font-medium ${on ? "text-foreground" : "text-muted-foreground"}`}>
            {busy ? "…" : on ? "ON" : "OFF"}
          </span>
        </div>
      </div>
    </Pressable>
  );
}
