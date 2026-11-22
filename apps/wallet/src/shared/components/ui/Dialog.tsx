import { Dialog as UiDialog, DialogContent } from "@ui-sdk/react/dialog";
import type { ReactNode } from "react";
import { cn } from "../../styles/cn";

// shadcn Dialog on ui-sdk behavior (top layer, focus trap, Escape, return
// focus) with the wallet's skin: the layer is transparent and full-bleed, so
// the caller owns the surface — scrim and panel look exactly as before.
export function Dialog({
  open,
  onDismiss,
  label,
  dismissible = true,
  className,
  children,
}: {
  open: boolean;
  onDismiss?: () => void;
  label?: string;
  dismissible?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <UiDialog
      open={open}
      dismissible={dismissible}
      onOpenChange={(next) => {
        if (!next) onDismiss?.();
      }}
    >
      <DialogContent
        aria-label={label}
        className={cn(
          "fixed inset-0 m-0 block h-dvh w-screen max-h-none max-w-none overflow-visible rounded-none border-0 bg-transparent p-0 font-sans text-base leading-normal text-foreground shadow-none outline-none",
          className,
        )}
      >
        {children}
      </DialogContent>
    </UiDialog>
  );
}
