import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Label } from "./label";

/** shadcn Field family: one vertical rhythm for labelled controls. Pass the
 *  control id to FieldLabel; FieldError is announced on its own. */
export function Field({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div data-slot="field" className={cn("flex flex-col gap-1", className)} {...props} />;
}

export function FieldLabel({ className, ...props }: ComponentPropsWithoutRef<"label">) {
  return <Label data-slot="field-label" className={className} {...props} />;
}

export function FieldDescription({ className, ...props }: ComponentPropsWithoutRef<"p">) {
  return <p data-slot="field-description" className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function FieldError({ className, children, ...props }: ComponentPropsWithoutRef<"p">) {
  if (!children) return null;
  return (
    <p role="alert" data-slot="field-error" className={cn("text-xs text-red-600 dark:text-red-400", className)} {...props}>
      {children as ReactNode}
    </p>
  );
}
