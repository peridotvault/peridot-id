import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";

// shadcn Button in the dashboard's skin (peridotbase): 6px corners, one
// padding scale, 150ms ease-out, pressed scale. `default` is the primary
// action (peridot green) — solid white is gone so a button always reads as
// clickable against the near-black surface.
export const buttonVariants = cva(
  "inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-transparent font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out active:scale-[0.98] focus-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary font-semibold text-primary-foreground hover:bg-primary/85",
        outline: "border-border text-foreground hover:bg-muted/50",
        secondary: "bg-muted/60 text-foreground hover:bg-muted/50",
        ghost: "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 px-2 text-xs",
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-3.5 text-sm",
        lg: "h-10 px-4 text-sm",
        icon: "size-8",
      },
    },
    defaultVariants: { variant: "outline", size: "xs" },
  },
);

type ButtonProps = ComponentPropsWithoutRef<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      data-slot="button"
      data-variant={variant ?? "outline"}
      data-size={size ?? "xs"}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
