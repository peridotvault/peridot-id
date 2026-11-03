import { Pressable } from "./Pressable";
import { Check } from "../icons";

// On/off setting row: icon, label, hint, and a switch at the right edge. One
// control primitive so Settings and the Chains page can't drift apart.
// The switch is optimistic: it reflects the store immediately on press — never
// a "…"/disabled state (data hooks reload in the background, signing stays
// blocked by the network-transition window).
export function ToggleRow({
  icon: Icon,
  label,
  hint,
  on,
  testnet,
  onPress,
  className = "px-6",
}: {
  icon: typeof Check;
  label: string;
  hint: string;
  on: boolean;
  testnet?: boolean;
  onPress: () => void;
  className?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="w-full"
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={testnet ? `${label} (testnet)` : label}
    >
      <div className={`flex w-full items-center justify-between gap-3 py-3 transition-colors hover:bg-surface ${className}`}>
        <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-line bg-surface">
          <Icon size={18} className="text-foreground" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-sans text-base font-medium text-foreground">{label}</span>
          <span className="font-sans text-xs text-muted-foreground">{hint}</span>
        </div>
        {testnet && <span className="font-sans text-xs font-bold tracking-[1px] text-muted-foreground">TESTNET</span>}
        <div className={`flex h-5 w-10 shrink-0 items-center border p-[2px] ${on ? "justify-end border-accent bg-accent" : "justify-start border-border bg-surface"}`}>
          <span aria-hidden className={`h-full w-3.5 shrink-0 ${on ? "bg-background" : "bg-muted-foreground"}`} />
        </div>
      </div>
    </Pressable>
  );
}
