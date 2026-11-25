import { useEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Anchored popover chrome shared by the wallet and the dashboard: scrim, panel
 * portaled to <body> (never trapped under a sticky topbar), fixed coordinates
 * from the anchor, grow-in/shrink-out (`.menu-in`/`.menu-out`, `popover.css`),
 * Escape to close. Content is the caller's rows.
 */
export function Popover({
  open,
  onClose,
  anchor,
  label,
  className = "",
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Element the panel hangs from (its bottom-right corner). */
  anchor: RefObject<HTMLElement | null>;
  /** Accessible name of the menu (scrim and panel). */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<CSSProperties | null>(null);
  // Stays mounted through the exit animation instead of vanishing on close.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) {
        setPos({
          position: "fixed",
          top: rect.bottom + 8,
          right: Math.max(8, window.innerWidth - rect.right),
        });
      }
      return;
    }
    const timer = setTimeout(() => setMounted(false), 140);
    return () => clearTimeout(timer);
  }, [open, anchor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || !pos) return null;
  return createPortal(
    <>
      <button
        type="button"
        aria-label={`Close ${label}`}
        data-sfx="scrim"
        onClick={onClose}
        className={`fixed inset-0 z-40 cursor-default ${open ? "scrim-in" : "scrim-out"}`}
      />
      <div
        role="menu"
        aria-label={label}
        style={pos}
        className={`z-50 flex w-72 flex-col gap-1 rounded-lg border border-line bg-surface p-1 shadow-lg ${open ? "menu-in" : "menu-out"} ${className}`}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
