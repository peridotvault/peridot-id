import { Text, View } from "../primitives";
import { AsciiRidges } from "./AsciiRidges";

// Branded loader — pixel-identical backdrop to the login screen (same
// AsciiRidges config, veil, and opacity, all owned by the shared component)
// with the serif PeridotID masthead centered. Used while the SSO session
// check runs so the login form never flashes before the consent modal — and
// as the cold-start splash (fontsReady=false renders system fallbacks so
// first paint never waits on font files).
export function LoadingScreen({ fontsReady = true }: { fontsReady?: boolean }) {
  return (
    <View className="flex-1">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <View className="flex-1 items-center justify-center">
        <Text className={fontsReady ? "font-serif text-[40px] tracking-[-0.4px] text-foreground" : "font-[serif] text-[40px] tracking-normal text-foreground"}>PeridotID</Text>
      </View>
    </View>
  );
}
