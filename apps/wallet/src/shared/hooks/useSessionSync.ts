import { useEffect, useRef } from "react";

// Cross-tab / refocus session sync. A login in another tab (or the login
// popup, whose cookie write can't notify this tab) leaves an already-open
// window showing logged-out. When logged out, re-check on focus, on becoming
// visible, or on the popup's session ping. Shell-wide → shared/hooks.
// Conditions read through refs so the listeners subscribe once.
export function useSessionSync(opts: {
  bootstrap: () => void;
  /** Popup windows own their lifecycle — never disturb them. */
  disabled: boolean;
  isAuthed: boolean;
}) {
  const bootstrapRef = useRef(opts.bootstrap);
  bootstrapRef.current = opts.bootstrap;
  const disabledRef = useRef(opts.disabled);
  disabledRef.current = opts.disabled;
  const authedRef = useRef(opts.isAuthed);
  authedRef.current = opts.isAuthed;

  useEffect(() => {
    if (typeof window === "undefined") return;
    let last = 0;
    const recheck = () => {
      if (disabledRef.current || authedRef.current) return;
      const now = Date.now();
      if (now - last < 2000) return;
      last = now;
      void bootstrapRef.current();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === "pid_session_ping") recheck();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
}
