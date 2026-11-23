import type { ReactNode } from "react";
import { cn } from "../../styles/cn";

// One label/value line (fees, quotes, totals). Shared because feat/chain's fee
// panel and feat/fiat's quote breakdown had private copies of the same row.
export function AmountRow({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={cn("font-sans text-sm", strong ? "font-semibold text-foreground" : "text-muted-foreground")}>
        {label}
      </span>
      <span className={cn("select-text font-mono text-sm text-foreground", strong && "font-semibold")}>{value}</span>
    </div>
  );
}
