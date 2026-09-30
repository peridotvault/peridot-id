import { StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { AsciiRidges } from "./AsciiRidges";

// Branded loader — pixel-identical backdrop to the login screen (same
// AsciiRidges config, veil, and opacity, all owned by the shared component)
// with the serif PeridotID masthead centered. Used while the SSO session
// check runs so the login form never flashes before the consent modal — and
// as the cold-start splash (fontsReady=false renders system fallbacks so
// first paint never waits on font files).
export function LoadingScreen({ fontsReady = true }: { fontsReady?: boolean }) {
  return (
    <View style={styles.screen}>
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <View style={styles.center}>
        <Text style={[styles.logo, !fontsReady && styles.logoFallback]}>PeridotID</Text>
      </View>
    </View>
  );
}

const c = theme.colors;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  logo: {
    fontSize: 40,
    fontWeight: "400",
    color: c.foreground,
    fontFamily: "SourceSerif4_400Regular",
    letterSpacing: -0.4,
  },
  logoFallback: {
    fontFamily: "serif",
    letterSpacing: 0,
  },
});
