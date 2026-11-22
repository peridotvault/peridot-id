import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

// One chip treatment for the whole dashboard: pill, 11px semibold, tinted
// background + matching text. Dark-only app, so no `dark:` duplication.
const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] font-semibold leading-tight",
  {
    variants: {
      tone: {
        muted: "bg-muted/50 text-muted-foreground",
        success: "bg-emerald-500/15 text-emerald-300",
        warning: "bg-amber-400/15 text-amber-300",
        danger: "bg-destructive/15 text-red-300",
        brand: "bg-brand-1/25 text-brand-2",
      },
    },
    defaultVariants: { tone: "muted" },
  },
);

type BadgeProps = ComponentPropsWithoutRef<"span"> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span data-slot="badge" data-tone={tone ?? "muted"} className={cn(badgeVariants({ tone }), className)} {...props} />;
}
