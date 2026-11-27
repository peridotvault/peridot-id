import type { ComponentPropsWithoutRef } from "react";
import { Button } from "./button";
import { inputClass } from "./input";

// Screen-facing surface: screens import these, never the primitives directly.
export { Card } from "./card";
export { Badge } from "./badge";
export { Dialog } from "./dialog";
export { Segmented, SegmentedItem } from "./segmented";

/** Small themed button (outline or solid) for card actions. */
type MiniButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className"> & {
  className?: string;
  variant?: "outline" | "solid" | "danger" | "dangerSolid";
  size?: "xs" | "sm" | "md" | "lg";
};

/** Small themed button: shadcn Button with the card-action size table. */
export function MiniButton({ variant = "outline", size = "xs", className, ...rest }: MiniButtonProps) {
  return (
    <Button
      variant={variant === "solid" ? "default" : variant === "danger" ? "destructive" : variant === "dangerSolid" ? "destructive-solid" : "outline"}
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
export const DANGER = "text-destructive";

/** Big changing figure (balance, counters): mono + tabular so digits do not jitter. */
export const METRIC = "font-mono font-semibold tabular-nums tracking-tight";

/** Connecting hairline between blocks. */
export const DIVIDER = "border-t border-line";
