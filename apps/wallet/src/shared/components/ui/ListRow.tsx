import type { ReactNode } from "react";
import { Pressable } from "./Pressable";
import { cn } from "../../styles/cn";

// The one list row for the whole wallet: hairline rail-to-rail, `px-6 py-3`,
// 12px gap. Paint lives on the inner div because Pressable pins its own
// border/padding to zero inline — a class cannot win against an inline style.
// `hairline={false}` is for lists whose parent already draws dividers.
export function ListRow({
  children,
  onPress,
  disabled,
  accessibilityLabel,
  className,
  hairline = true,
}: {
  children: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Extra classes for the inner row (alignment, hover tint). */
  className?: string;
  hairline?: boolean;
}) {
  const row = (
    <div
      className={cn(
        "flex w-full items-center gap-3 px-6 py-3",
        hairline && "border-t border-line",
        onPress && "hover:bg-surface",
        className,
      )}
    >
      {children}
    </div>
  );
  if (!onPress) return row;
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityLabel={accessibilityLabel} className="w-full text-left">
      {row}
    </Pressable>
  );
}

// Leading square for a row (icon or avatar fallback). 36px, md radius — the
// one tile size in the wallet; tint keeps the activity/fiat colour encoding.
export function RowTile({ children, tint, className }: { children: ReactNode; tint?: string; className?: string }) {
  return (
    <div
      style={tint ? { backgroundColor: tint + "22" } : undefined}
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-md",
        !tint && "border border-line bg-surface",
        className,
      )}
    >
      {children}
    </div>
  );
}
