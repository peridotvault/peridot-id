import { ScrollArea } from "../../../shared/components/ui/ScrollArea";
import { Pressable } from "../../../shared/components/ui/Pressable";
import { Section, SectionHead } from "../../../shared/components/ui/Section";
import { SectionTitle } from "../../../shared/components/ui/SectionTitle";
import { fmtIdr } from "../../../shared/data/fiat";
import { formatTotalParts } from "../../../shared/data/currency";

// Fiat balances as two simple ATM-style cards: currency + amount, nothing else.
// The payment gateway is an implementation detail — the user never needs to read
// "DOKU" or "Stripe" on Home. Cards are 256px wide, so they sit side by side at
// the column width and swipe on phones. No rail under the header: the cards are
// objects, not cells.
const CARD =
  "flex aspect-[1.586] w-64 shrink-0 flex-col justify-between border border-line bg-surface p-4";

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
  // No Stripe account exists yet — the mirrored balance is honestly zero.
  const stripeZero = formatTotalParts(0, "USD");

  return (
    <Section>
      <SectionHead>
        <SectionTitle>Fiat</SectionTitle>
      </SectionHead>

      <ScrollArea horizontal className="pb-5">
        <div style={{ flexDirection: "row" }} className="flex gap-3 px-6">
          {balanceError ? (
            <div className={CARD}>
              <CardTop flag="id.webp" label="Rupiah" />
              <p role="alert" className="font-sans text-xs leading-4 text-foreground">{balanceError}</p>
              <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry loading the Rupiah balance">
                <span className="self-start border-b border-foreground py-0.5 font-sans text-sm font-medium text-foreground">
                  Retry
                </span>
              </Pressable>
            </div>
          ) : (
            <Pressable className="shrink-0" onPress={onOpen} accessibilityLabel="Open Rupiah account">
              <div className={`${CARD} transition-colors hover:border-border`}>
                <CardTop flag="id.webp" label="Rupiah" />
                <span
                  className="truncate font-mono text-2xl text-foreground"
                  role={balanceIdr === null && busy ? "status" : undefined}
                  aria-label={balanceIdr === null && busy ? "Loading Rupiah balance" : undefined}
                >
                  {balanceIdr === null ? (busy ? "…" : "—") : fmtIdr(balanceIdr)}
                </span>
              </div>
            </Pressable>
          )}

          <div className={`${CARD} opacity-50`} aria-label="US Dollar balance, coming soon">
            <CardTop flag="usa.webp" label="US Dollar" />
            <span className="truncate font-mono text-2xl text-foreground">
              {stripeZero.prefix}{stripeZero.int}
              <span className="text-muted-foreground">{stripeZero.frac}</span>
            </span>
          </div>
        </div>
      </ScrollArea>
    </Section>
  );
}

function CardTop({ flag, label }: { flag: string; label: string }) {
  return (
    <div style={{ flexDirection: "row" }} className="flex items-center justify-between">
      <span className="font-sans text-xs font-medium uppercase tracking-[0.6px] text-muted-foreground">{label}</span>
      <img src={`/payment-gateway/${flag}`} alt="" className="h-5 w-5 object-cover" />
    </div>
  );
}
