import { Pressable } from "../../../shared/components/ui/Pressable";
import type { DepositQuoteView } from "@peridotvault/pid-sdk-js";
import { styles as s } from "../../../shared/styles/theme";
import { fmtIdr, sumIdr } from "../../../shared/data/fiat";

// Single copy of the DOKU-checkout quote UI shared by Topup and
// ApproveScreen (fiat-checkout): fee breakdown + payment-method picker.
// Screens may import any feat, so this lives in feat/fiat (not shared/).
export function FiatQuoteBreakdown({
  quote,
  transferFee,
  selectedTotalIdr,
  method,
  editable,
  onMethod,
}: {
  quote: DepositQuoteView;
  transferFee: string;
  selectedTotalIdr: string;
  method: string | null;
  /** False renders the breakdown read-only (Approve busy phase). */
  editable: boolean;
  onMethod: (key: string) => void;
}) {
  return (
    <>
      <div className="flex flex-col mt-2 gap-1">
        <Row label="Amount" value={fmtIdr(quote.netIdr)} />
        {BigInt(transferFee) > 0n && <Row label="Transfer Fee" value={fmtIdr(transferFee)} />}
        {Number(quote.appFeeIdr) > 0 && <Row label="App Fee" value={fmtIdr(quote.appFeeIdr)} />}
        <Row label="Total Payment" value={fmtIdr(selectedTotalIdr)} strong />
      </div>
      {editable && (
        <>
          <span style={s.label}>Payment method</span>
          <div className="flex flex-col mt-0.5 gap-1.5">
            {quote.paymentMethods.map((m) => (
              <Pressable
                key={m.key}
                onPress={() => onMethod(m.key)}
                accessibilityLabel={`Pay with ${m.label}`}
              >
                <div style={{ flexDirection: "row" }} className={`flex flex-col w-full items-center justify-between border px-2.5 py-2 ${method === m.key ? "border-foreground" : "border-border"}`}>
                  <span className={`font-sans text-sm text-foreground ${method === m.key ? "font-semibold" : ""}`}>{m.label}</span>
                  {m.enabled && <span className="font-mono text-sm text-muted-foreground">{fmtIdr(sumIdr(m.gatewayFeeIdr, m.gatewayTaxIdr))}</span>}
                </div>
              </Pressable>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** One label/value line of the quote breakdown. */
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ flexDirection: "row" }} className="flex flex-col items-center justify-between">
      <span className={`font-sans text-sm ${strong ? "font-bold text-foreground" : "text-muted-foreground"}`}>{label}</span>
      <span className={`font-mono text-sm text-foreground ${strong ? "font-bold" : ""}`}>{value}</span>
    </div>
  );
}
