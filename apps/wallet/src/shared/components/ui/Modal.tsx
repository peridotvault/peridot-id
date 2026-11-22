import type { ReactNode } from "react";
import { Dialog } from "./Dialog";

// Modal keeps its call-shape (visible / onRequestClose / label) but delegates
// the behavior to shadcn Dialog over ui-sdk: top layer, focus trap, Escape,
// focus returned to the trigger.
export function Modal({
  visible,
  onRequestClose,
  children,
  label,
}: {
  visible?: boolean;
  transparent?: boolean;
  animationType?: string;
  onRequestClose?: () => void;
  children?: ReactNode;
  label?: string;
}) {
  return (
    <Dialog open={Boolean(visible)} onDismiss={onRequestClose} label={label}>
      {children}
    </Dialog>
  );
}
