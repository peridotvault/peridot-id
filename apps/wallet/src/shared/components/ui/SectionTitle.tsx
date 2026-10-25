import type { ReactNode } from "react";

// Single group-title style (Total Balance, Fiat, …) so labels can't drift.
// Extra layout (e.g. px-1) stays at the call site via className. `as` picks
// the semantic tag — h1 for the screen's main title, span elsewhere.
export function SectionTitle({
  children,
  className,
  as: Tag = "span",
}: {
  children: ReactNode;
  className?: string;
  as?: "span" | "p" | "h1" | "h2";
}) {
  return <Tag className={`font-sans text-sm text-muted-foreground ${className ?? ""}`}>{children}</Tag>;
}
