import { useEffect, useState } from "react";
import { useFonts, Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from "@expo-google-fonts/geist";
import { SourceSerif4_400Regular } from "@expo-google-fonts/source-serif-4";
import { JetBrainsMono_400Regular } from "@expo-google-fonts/jetbrains-mono";

// Startup gate: brand fonts + failsafe timeout + splash handoff. Shell-wide
// (not feature-scoped), so it lives in shared/hooks.
export function useStartupGate() {
  // Web type system (Geist + Source Serif 4, same as apps/web). Bundled via
  // expo-font so it works offline on web + native; splash holds until loaded.
  const [fontsLoaded, fontError] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    SourceSerif4_400Regular,
    JetBrainsMono_400Regular,
  });
  // Failsafe: a hung gate (fonts or network that never settles with no error)
  // must never trap the app on the loader forever — force it open degraded.
  const [gateForced, setGateForced] = useState(false);

  useEffect(() => {
    if (!fontError) return;
    // eslint-disable-next-line no-console
    console.warn("[startup] font load failed — continuing with system fallbacks", fontError);
  }, [fontError]);

  useEffect(() => {
    const id = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn("[startup] gate timed out after 8s — opening degraded");
      setGateForced(true);
    }, 8000);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    // Static pre-JS splash handoff: React mounted, drop the template node.
    if (typeof document !== "undefined") document.getElementById("splash")?.remove();
  }, []);

  return { fontsLoaded, fontError, gateForced };
}
