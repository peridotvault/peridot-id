import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { LoginMethod } from "./types.js";

/** Maximum z-index: the modal sits in front of any client UI. */
const MAX_Z = 2147483647;

const LABELS: Record<LoginMethod, string> = {
  google: "Continue with Google",
  passkey: "Continue with Passkey",
};

export interface PeridotLoginModalProps {
  open: boolean;
  methods: LoginMethod[];
  /** Which method is currently running its ceremony (shows a spinner label). */
  busyMethod: LoginMethod | null;
  error: string | null;
  title?: string;
  subtitle?: string;
  onGoogle: () => void;
  onPasskey: () => void;
  onClose: () => void;
}

export function PeridotLoginModal({
  open,
  methods,
  busyMethod,
  error,
  title = "Sign in with PeridotID",
  subtitle,
  onGoogle,
  onPasskey,
  onClose,
}: PeridotLoginModalProps) {
  // Portal target only exists in the browser (SSR-safe: renders nothing server-side).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open || !mounted || typeof document === "undefined") return null;

  const handlers: Record<LoginMethod, () => void> = { google: onGoogle, passkey: onPasskey };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: MAX_Z,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        backgroundColor: "rgba(0, 0, 0, 0.45)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 360,
          backgroundColor: "#ffffff",
          color: "#111111",
          borderRadius: 16,
          padding: 24,
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.35)",
          position: "relative",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            border: "none",
            background: "transparent",
            fontSize: 20,
            lineHeight: 1,
            cursor: "pointer",
            color: "#666666",
            padding: 4,
          }}
        >
          ×
        </button>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 13, color: "#666666", marginBottom: 16 }}>{subtitle}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: subtitle ? 0 : 16 }}>
          {methods.map((m) => {
            const busy = busyMethod !== null;
            return (
              <button
                key={m}
                type="button"
                onClick={handlers[m]}
                disabled={busy}
                style={{
                  width: "100%",
                  padding: "12px 16px",
                  borderRadius: 10,
                  border: "1px solid #dddddd",
                  backgroundColor: busyMethod === m ? "#f0f0f0" : "#ffffff",
                  color: "#111111",
                  fontSize: 15,
                  fontWeight: 600,
                  cursor: busy ? "wait" : "pointer",
                  opacity: busy && busyMethod !== m ? 0.6 : 1,
                }}
              >
                {busyMethod === m ? "Waiting…" : LABELS[m]}
              </button>
            );
          })}
        </div>
        {error && <div style={{ marginTop: 12, fontSize: 13, color: "#c62828" }}>{error}</div>}
        <div style={{ marginTop: 16, fontSize: 11, color: "#999999", textAlign: "center" }}>
          Secured by PeridotID
        </div>
      </div>
    </div>,
    document.body,
  );
}
