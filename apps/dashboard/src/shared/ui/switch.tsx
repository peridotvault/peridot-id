import { Switch as UiSwitch, SwitchThumb } from "@ui-sdk/react/switch";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";

// shadcn Switch on ui-sdk behavior (role=switch, keyboard, form input) with
// the dashboard skin: a 36x20 pill, matching the chip language.
type SwitchProps = ComponentProps<typeof UiSwitch> & {
  checked: boolean;
  thumbClassName?: string;
};

export function Switch({ checked, className, thumbClassName, ...props }: SwitchProps) {
  return (
    <UiSwitch
      checked={checked}
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-sm border transition-colors duration-150 focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "border-primary bg-primary" : "border-border bg-muted",
        className,
      )}
      {...props}
    >
      <SwitchThumb
        className={cn(
          "pointer-events-none inline-block size-3.5 rounded-sm bg-background shadow-sm transition-transform duration-150",
          checked ? "translate-x-[17px]" : "translate-x-[3px]",
          thumbClassName,
        )}
      />
    </UiSwitch>
  );
}
