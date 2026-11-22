import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

/** Rounded content panel (peridotbase look): 14px corners, hairline border, no
 *  shadow. Everything that groups content is a Card — never a bare bordered div. */
export function Card({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="card"
      className={cn("rounded-xl border border-line bg-card p-5", className)}
      {...props}
    />
  );
}
