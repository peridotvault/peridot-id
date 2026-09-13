"use client";

import type { CSSProperties, ComponentPropsWithoutRef, ReactNode } from "react";

/** One-corner card cut — same clip as the landing features/pricing cards. */
const CARD_CLIP: CSSProperties = {
  clipPath: "polygon(0 0, calc(100% - 34px) 0, 100% 34px, 100% 100%, 0 100%)",
};

/** Small two-corner cut for mini buttons. */
const MINI_CUT =
  "[clip-path:polygon(5px_0,100%_0,100%_calc(100%-5px),calc(100%-5px)_100%,0_100%,0_5px)]";

/** Hairline-cut card: 1px border illusion (outer bg-border p-px + inner surface). */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bg-border p-px ${className}`} style={CARD_CLIP}>
      <div className="bg-background p-6" style={CARD_CLIP}>
        {children}
      </div>
    </div>
  );
}

type MiniButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className" | "type"> & {
  className?: string;
  variant?: "outline" | "solid";
  size?: "xs" | "sm";
};

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
      className={`inline-flex shrink-0 items-center gap-1 transition-colors focus-ring disabled:opacity-60 ${pad} ${skin} ${MINI_CUT} ${className}`}
      {...rest}
    />
  );
}

/** Themed text input / select. */
export const FIELD =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-ring";

/** Section eyebrow + titles, landing hierarchy. */
export const EYEBROW = "text-sm font-medium text-muted-foreground";
export const SECTION_TITLE = "text-lg font-semibold tracking-tight";
export const SECTION_LABEL = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

/** Muted copy + errors, readable on both themes. */
export const MUTED = "text-muted-foreground";
export const ERROR = "text-red-600 dark:text-red-400";
export const WARN = "text-amber-700 dark:text-amber-300";

/** Landing dotted divider. */
export const DIVIDER = "border-t border-dotted border-border";
