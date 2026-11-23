import type { ComponentPropsWithoutRef } from "react";
import { cn } from "../lib/cn";
import { inputClass } from "./input";

/** Native <select> in the dashboard skin: the OS menu is the right picker for
 *  a handful of options. ui-sdk's Select is for searchable lists. */
export function Select({ className, ...props }: ComponentPropsWithoutRef<"select">) {
  return <select data-slot="select" className={cn(inputClass, "pr-2", className)} {...props} />;
}
