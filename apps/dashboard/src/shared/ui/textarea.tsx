import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../../lib/cn";
import { inputClass } from "./input";

export function Textarea({ className, ...props }: ComponentPropsWithoutRef<"textarea">) {
  return <textarea data-slot="textarea" className={cn(inputClass, "h-auto min-h-20 py-2", className)} {...props} />;
}
