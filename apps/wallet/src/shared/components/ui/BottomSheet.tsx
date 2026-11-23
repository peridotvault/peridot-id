import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "./Dialog";
import { Pressable } from "../ui/Pressable";
import { StyleSheet } from "../../styles/stylesheet";
import { cn } from "../../styles/cn";
import { X } from "../icons";

// Exit animation length (`sheet-shrink` / `sheet-down` in base.css): the sheet
// stays mounted this long after `visible` flips false.
const EXIT_MS = 180;

// Shared drawer: bottom-docked sheet slides up from the edge, `center` grows
// from its own midline. Both shrink/slide back on close.
// ponytail: marginHorizontal auto is the centering fix — left:0/right:0 alone
// pins an absolute view full-bleed, so maxWidth without it never centers.
export function BottomSheet({
  visible,
  title,
  onClose,
  closeDisabled,
  scrimLabel,
  center,
  className,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  scrimLabel?: string;
  /** Center the panel in the viewport instead of docking it to the bottom. */
  center?: boolean;
  /** Panel skin/width override (callers may want another surface or max width). */
  className?: string;
  children: ReactNode;
}) {
  // The dialog outlives `visible` by one exit animation, so closing plays the
  // exit instead of popping the panel out of existence.
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [visible]);

  return (
    <Dialog open={mounted} onDismiss={onClose} label={title} dismissible={!closeDisabled}>
      <Pressable
        style={styles.scrim}
        className={visible ? "scrim-in" : "scrim-out"}
        onPress={closeDisabled ? undefined : onClose}
        accessibilityLabel={scrimLabel ?? `Close ${title}`}
      />
      <div
        className={cn(
          "flex flex-col absolute left-0 right-0 mx-auto max-h-[75%] w-full max-w-[576px] gap-3 overflow-y-auto bg-surface p-5",
          center
            ? "top-1/2 -translate-y-1/2 rounded-xl border border-border"
            : "bottom-0 self-center rounded-t-xl border-t border-border pb-7",
          visible ? (center ? "sheet-grow" : "sheet-up") : center ? "sheet-shrink" : "sheet-down",
          className,
        )}
      >
        <div className="flex flex-row items-center justify-between">
          <span className="font-sans text-2xl tracking-[-0.3px] text-foreground">{title}</span>
          <Pressable onPress={onClose} disabled={closeDisabled} accessibilityLabel="Close">
            <div className="flex flex-col p-1.5">
              <X size={18} className="text-muted-foreground" />
            </div>
          </Pressable>
        </div>
        {children}
      </div>
    </Dialog>
  );
}

// The scrim keeps a stylesheet: it is a Pressable whose dim background must
// beat the shim's inline `background: none` — no class can do that.
const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0, 0, 0, 0.6)" },
});
