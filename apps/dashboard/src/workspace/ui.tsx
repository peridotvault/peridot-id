import type { ComponentPropsWithoutRef } from "react";
import { Button } from "../shared/ui/button";
import { inputClass } from "../shared/ui/input";

// Screen-facing surface: screens import these, never the primitives directly.
export { Card } from "../shared/ui/card";
export { Badge } from "../shared/ui/badge";
export { Segmented, SegmentedItem } from "../shared/ui/segmented";

/** Small themed button (outline or solid) for card actions. */
type MiniButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className"> & {
  className?: string;
  variant?: "outline" | "solid";
  size?: "xs" | "sm" | "md" | "lg";
};

/** Small themed button: shadcn Button with the card-action size table. */
export function MiniButton({ variant = "outline", size = "xs", className, ...rest }: MiniButtonProps) {
  return (
    <Button
      variant={variant === "solid" ? "default" : "outline"}
      size={size}
      className={className}
      {...rest}
    />
  );
}

/** Themed text input / select (same string as <Input>). */
export const FIELD = inputClass;

/** Section eyebrow + titles, landing hierarchy. */
export const EYEBROW_UPPER = "text-xs font-medium uppercase tracking-widest text-muted-foreground";
export const SECTION_LABEL = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

/** Muted copy + errors, readable on both themes. */
export const MUTED = "text-muted-foreground";
export const ERROR = "text-red-600 dark:text-red-400";
export const WARN = "text-amber-700 dark:text-amber-300";

/** Big changing figure (balance, counters): mono + tabular so digits do not jitter. */
export const METRIC = "font-mono font-semibold tabular-nums tracking-tight";

/** Connecting hairline between blocks. */
export const DIVIDER = "border-t border-line";
