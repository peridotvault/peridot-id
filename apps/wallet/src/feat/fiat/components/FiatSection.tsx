import { ScrollArea } from "../../../shared/components/ui/ScrollArea";
import { Pressable } from "../../../shared/components/ui/Pressable";
import { AsciiRidges } from "../../../shared/components/ui/AsciiRidges";
import { styles as s } from "../../../shared/styles/theme";
import { UIButton } from "../../../shared/components/ui/UIButton";
import { fmtIdr } from "../../../shared/data/fiat";
import { formatTotalParts } from "../../../shared/data/currency";
import { SectionTitle } from "../../../shared/components/ui/SectionTitle";

// Fiat rail: DOKU (live Rupiah ledger) + Stripe (USD, coming soon).
// Square pair under the "Fiat" title. No new fetch — DOKU reuses the
// fiat balance Home already loads; Stripe is a static placeholder.
// Tapping the DOKU card opens the Rupiah account page; the error state
// stays a plain card so Retry never double-fires a navigation.
export function FiatSection({
  balanceIdr,
  balanceError,
  busy,
  onRetry,
  onOpen,
}: {
  balanceIdr: string | null;
  balanceError: string | null;
  busy: boolean;
  onRetry: () => void;
  onOpen: () => void;
}) {
  const frame = "flex flex-col relative h-40 w-40 shrink-0 justify-between overflow-hidden border border-border bg-surface p-4";
  // No Stripe account exists yet — the mirrored balance is honestly zero.
  const stripeZero = formatTotalParts(0, "USD");
  return (
    <div className="flex flex-col gap-2">
      <SectionTitle className="px-1">Fiat</SectionTitle>
      <ScrollArea horizontal contentContainerStyle={{ flexDirection: "row", gap: 12 }}>
        {balanceError ? (
          <div className={frame}>
            <CardArt />
            <div className="flex flex-col gap-2">
              <img src={"/payment-gateway/doku.svg"} alt="" className="h-7 w-auto grayscale" aria-label="DOKU" />
              <p role="alert" style={s.error}>{balanceError}</p>
            </div>
            <UIButton title="Retry" onPress={onRetry} />
          </div>
        ) : (
          <Pressable className="shrink-0" onPress={onOpen} accessibilityLabel="Open Rupiah account">
            <div className={frame}>
              <CardArt />
              <div className="flex">
                <img src={"/payment-gateway/id.webp"} alt="" className="h-7 aspect-square object-cover border border-border rounded" aria-label="Indonesia Flag" />
              </div>
              <span
                className="font-serif text-2xl"
                role={balanceIdr === null && busy ? "status" : undefined}
                aria-label={balanceIdr === null && busy ? "Loading IDR balance" : undefined}
              >
                {balanceIdr === null ? (busy ? "…" : "—") : fmtIdr(balanceIdr)}
              </span>
            </div>
          </Pressable>
        )}

        <div className={frame + " opacity-65 grayscale"}>
          <CardArt />
          <div className="flex">
            <img src={"/payment-gateway/usa.webp"} alt="" className="h-7 aspect-square object-cover border border-border rounded" aria-label="USA Flag" />
          </div>
          <span className="font-serif text-2xl" aria-label="USD balance zero, coming soon">
            {stripeZero.prefix}{stripeZero.int}{stripeZero.frac}
          </span>
        </div>
      </ScrollArea>
    </div>
  );
}

// Animated ASCII backdrop, same recipe as the old hero card: full-window
// grid clipped by overflow-hidden, so each square shows a center crop.
// pointerEvents none keeps the DOKU tap target working through the art.
function CardArt({ dimmed }: { dimmed?: boolean }) {
  return (
    <div className={`flex flex-col pointer-events-none absolute inset-0 overflow-hidden ${dimmed ? "opacity-40" : ""}`}>
      <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
      <div className="flex flex-col absolute inset-0 bg-black/10" />
    </div>
  );
}
