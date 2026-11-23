import type { ReactNode } from "react";

// One read-only detail line on a detail screen (status, dates, ids), already
// padded for a `divide-y` list inside a Section.
export function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-6 py-3">
      <span className="text-xs uppercase tracking-[0.6px] text-muted-foreground">{label}</span>
      <span className="select-text text-right font-sans text-sm text-foreground">{value}</span>
    </div>
  );
}
