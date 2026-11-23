import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn";

/** Segmented control (tabs / view switch). One container treatment for every
 *  tab group so they never drift apart. */
export function Segmented({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="segmented"
      className={cn(
        "inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-md border border-line bg-muted/40 p-1",
        className,
      )}
      {...props}
    />
  );
}

type SegmentedItemProps = ComponentPropsWithoutRef<"button"> & { active?: boolean };

export function SegmentedItem({ active = false, className, type = "button", ...props }: SegmentedItemProps) {
  return (
    <button
      type={type}
      aria-current={active ? "page" : undefined}
      data-slot="segmented-item"
      data-active={active ? "" : undefined}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-colors duration-150 active:scale-[0.98] focus-ring",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
