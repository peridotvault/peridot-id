import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

export function Label({ className, ...props }: ComponentPropsWithoutRef<"label">) {
  return <label data-slot="label" className={cn("text-xs", className)} {...props} />;
}
