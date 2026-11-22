import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

/** The dashboard's control skin. Exported as FIELD so raw <input> call sites
 *  (and <select>/<textarea>) keep the same string they had. */
export const inputClass =
  "mt-1 h-9 w-full min-w-0 rounded-sm border border-input bg-background px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground focus-ring disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...props }: ComponentPropsWithoutRef<"input">) {
  return <input data-slot="input" className={cn(inputClass, className)} {...props} />;
}
