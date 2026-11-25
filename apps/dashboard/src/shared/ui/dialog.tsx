import type { ReactNode } from "react";
import { Dialog as UiDialog, DialogContent } from "@ui-sdk/react/dialog";
import { cn } from "../lib/cn";

/**
 * Modal dialog: ui-sdk behavior (top layer, focus trap, Escape, focus
 * returned) with the dashboard skin (own scrim + centered card panel).
 */
export function Dialog({
  open,
  onDismiss,
  label,
  className,
  children,
}: {
  open: boolean;
  onDismiss?: () => void;
  /** Accessible name when the dialog title is not a heading of its own. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <UiDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss?.();
      }}
    >
      <DialogContent
        aria-label={label}
        className="fixed inset-0 m-0 flex h-dvh w-screen max-h-none max-w-none items-center justify-center rounded-none border-0 bg-transparent p-0 font-sans text-base leading-normal text-foreground shadow-none outline-none"
      >
        <div className="fixed inset-0 bg-black/60" aria-hidden="true" />
        <div
          className={cn(
            "relative w-[calc(100%-2rem)] max-w-md rounded-xl border border-line bg-card p-5 shadow-lg",
            className,
          )}
        >
          {children}
        </div>
      </DialogContent>
    </UiDialog>
  );
}
