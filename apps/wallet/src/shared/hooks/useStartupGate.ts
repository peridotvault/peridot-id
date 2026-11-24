import { useEffect, useState } from "react";

// Startup gate: brand fonts + failsafe timeout + splash handoff. Shell-wide
// (not feature-scoped), so it lives in shared/hooks.
export function useStartupGate() {
  // Web type system (Space Grotesk + JetBrains Mono, see brand.md). Loaded via
  // the Google Fonts <link> in index.html; the gate resolves when
  // document.fonts reports ready (or errors and falls back to system fonts).
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [fontError, setFontError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    if (typeof document === "undefined" || !("fonts" in document)) {
      setFontsLoaded(true);
      return;
    }
    document.fonts.ready.then(
      () => {
        if (alive) setFontsLoaded(true);
      },
      (e) => {
        if (alive) setFontError(e);
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  // Failsafe: a hung gate (fonts or network that never settles with no error)
  // must never trap the app on the loader forever — force it open degraded.
  // 8s proved too long on slow/blocked Google Fonts: the splash held the whole
  // app for 8s before painting anything. The first screen has no body text
  // (logo is an SVG), so a 2.5s cap costs at most a font swap, never a blank.
  const GATE_TIMEOUT_MS = 2500;
  const [gateForced, setGateForced] = useState(false);

  useEffect(() => {
    if (!fontError) return;
    // eslint-disable-next-line no-console
    console.warn("[startup] font load failed — continuing with system fallbacks", fontError);
  }, [fontError]);

  useEffect(() => {
    const id = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn("[startup] gate timed out — opening degraded (fonts still loading)");
      setGateForced(true);
    }, GATE_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    // Static pre-JS splash handoff: React mounted, drop the template node.
    if (typeof document !== "undefined") document.getElementById("splash")?.remove();
  }, []);

  return { fontsLoaded, fontError, gateForced };
}
