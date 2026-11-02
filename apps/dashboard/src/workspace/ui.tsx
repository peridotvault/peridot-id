import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Small themed button (outline or solid) for card actions. */
type MiniButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className" | "type"> & {
  className?: string;
  variant?: "outline" | "solid";
  size?: "xs" | "sm";
};

/** Content block: a connecting top rule, square corners — never a floating card. */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`border-t border-line bg-background p-6 ${className}`}>
      {children}
    </div>
  );
}

/** Small themed button (outline or solid) for card actions. */
export function MiniButton({ variant = "outline", size = "xs", className = "", ...rest }: MiniButtonProps) {
  const pad = size === "sm" ? "px-3 py-1.5 text-sm" : "px-2 py-1 text-xs";
  const skin =
    variant === "solid"
      ? "bg-foreground font-semibold text-background hover:bg-foreground/85"
      : "border border-border hover:bg-muted";
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center gap-1 transition-colors focus-ring disabled:opacity-60 ${pad} ${skin} ${className}`}
      {...rest}
    />
  );
}

/** Themed text input / select. */
export const FIELD =
  "mt-1 w-full border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-ring";

/** Section eyebrow + titles, landing hierarchy. */
export const EYEBROW_UPPER = "text-xs font-medium uppercase tracking-widest text-muted-foreground";
export const SECTION_LABEL = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

/** Muted copy + errors, readable on both themes. */
export const MUTED = "text-muted-foreground";
export const ERROR = "text-red-600 dark:text-red-400";
export const WARN = "text-amber-700 dark:text-amber-300";

/** Connecting hairline between blocks. */
export const DIVIDER = "border-t border-line";
