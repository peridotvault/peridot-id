import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../styles/cn";

// shadcn Button (cva variant table) wearing the wallet's skin: outline /
// primary / danger straight from brand.md, one 8px radius for every button
// (matches the peridotbase scale the dashboard uses). Press and disabled
// states stay opaque — opacity would let the page (and the login backdrop)
// show through the button surface. No transition on hover: the login page
// animates a full-screen WebGL canvas, so every animated frame of a colour
// fade repaints on top of it and the hover reads as lag. Solid swap = instant.
export const buttonVariants = cva(
  "flex flex-col rounded-md border active:scale-[0.98] disabled:pointer-events-none disabled:cursor-default disabled:active:scale-100",
  {
    variants: {
      variant: {
        outline:
          "border-border bg-elevated text-foreground hover:bg-muted disabled:text-muted-foreground",
        primary:
          "border-foreground bg-foreground text-background hover:brightness-95 disabled:border-muted disabled:bg-muted disabled:text-background",
        danger:
          "border-danger bg-elevated text-danger hover:bg-muted disabled:border-line disabled:text-muted-foreground",
      },
      align: {
        // Every button is the same 52px row, icon or not (login page columns).
        center: "min-h-13 items-center justify-center px-5",
        left: "min-h-13 items-stretch justify-center px-5",
      },
    },
    defaultVariants: { variant: "outline", align: "center" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, align, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      data-slot="button"
      data-variant={variant ?? "outline"}
      data-align={align ?? "center"}
      className={cn(buttonVariants({ variant, align }), className)}
      {...props}
    />
  );
}
