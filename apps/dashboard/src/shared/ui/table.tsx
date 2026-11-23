import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn";

// shadcn Table parts on plain markup. The parts own the shared rhythm (hairline
// rows, uppercase head) so screens only set their own column padding.
export function Table({ className, ...props }: ComponentPropsWithoutRef<"table">) {
  return <table data-slot="table" className={cn("w-full border-collapse text-left", className)} {...props} />;
}

export function TableHeader(props: ComponentPropsWithoutRef<"thead">) {
  return <thead data-slot="table-header" {...props} />;
}

export function TableBody(props: ComponentPropsWithoutRef<"tbody">) {
  return <tbody data-slot="table-body" {...props} />;
}

export function TableRow({ className, ...props }: ComponentPropsWithoutRef<"tr">) {
  return <tr data-slot="table-row" className={cn("border-b border-line", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentPropsWithoutRef<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn("text-left text-xs font-medium uppercase tracking-wide text-muted-foreground", className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentPropsWithoutRef<"td">) {
  return <td data-slot="table-cell" className={cn("align-top", className)} {...props} />;
}
