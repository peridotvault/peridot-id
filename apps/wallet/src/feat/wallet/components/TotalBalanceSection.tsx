
import { formatTotalParts, type Currency } from "../../../shared/data/currency";
import { SectionTitle } from "../../../shared/components/ui/SectionTitle";

// New top section: portfolio total (fiat + crypto). Reuses the same
// calcTotal value as the card — no new fetch, no new logic. Integer leg is
// 5xl, the 2-decimal leg rides smaller + muted on the same baseline.
export function TotalBalanceSection({
  currency,
  totalValue,
  loading,
}: {
  currency: Currency;
  totalValue: number;
  loading: boolean;
}) {
  const { prefix, int, frac } = formatTotalParts(totalValue, currency);
  return (
    <div className="flex flex-col gap-1 px-1">
      <SectionTitle as="h1">Total Balance</SectionTitle>
      {loading ? (
        <span
          className="font-serif text-5xl text-foreground"
          role="status"
          aria-label="Loading total balance"
        >
          …
        </span>
      ) : (
        <div style={{ flexDirection: "row" }} className="flex flex-col items-baseline" aria-label={`${prefix}${int}${frac}`}>
          <span className="font-serif text-5xl text-foreground">{prefix}{int}</span>
          <span className="font-serif text-4xl text-muted-foreground">{frac}</span>
        </div>
      )}
    </div>
  );
}
