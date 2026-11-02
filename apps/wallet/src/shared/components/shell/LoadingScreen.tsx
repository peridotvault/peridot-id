
import { AsciiRidges } from "../ui/AsciiRidges";
import { BrandMark } from "../ui/BrandMark";

// Branded loader — pixel-identical backdrop to the login screen (same
// AsciiRidges config, veil, and opacity, all owned by the shared component)
// with the PeridotID lockup centered. Used while the SSO session check runs so
// the login form never flashes before the consent modal — and as the cold-start
// splash, whose pre-JS twin in index.html mirrors this lockup.
export function LoadingScreen() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col flex-1">
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <div className="flex flex-col flex-1 items-center justify-center">
        <BrandMark size="lg" />
      </div>
    </div>
  );
}
