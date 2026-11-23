import type { ReactNode } from "react";
import { cn } from "../../styles/cn";

// One field/section caption for the whole wallet: uppercase micro-label.
// `htmlFor` renders a real <label>; without it a plain <span>.
export function Label({
  children,
  htmlFor,
  className,
}: {
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  // `block` keeps a caption on its own line inside a flex column.
  const cls = cn("block text-xs font-medium uppercase tracking-[0.6px] text-muted-foreground", className);
  return htmlFor ? (
    <label htmlFor={htmlFor} className={cls}>
      {children}
    </label>
  ) : (
    <span className={cls}>{children}</span>
  );
}
