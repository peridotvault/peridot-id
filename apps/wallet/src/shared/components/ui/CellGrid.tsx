import type { ReactNode } from "react";

// Connected-line grid (brand.md): the 1px gap *is* the divider, so neighbouring
// cells share one continuous rail instead of each carrying its own border.
export function CellGrid({
  cols = "grid-cols-1",
  className,
  children,
}: {
  cols?: string;
  className?: string;
  children: ReactNode;
}) {
  return <div className={`grid gap-px bg-line ${cols} ${className ?? ""}`}>{children}</div>;
}

/** Opaque cell for CellGrid — the line only shows through the gaps. */
export function Cell({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={`min-w-0 bg-background ${className ?? ""}`}>{children}</div>;
}
