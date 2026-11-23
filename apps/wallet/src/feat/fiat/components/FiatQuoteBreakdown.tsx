import { AmountRow } from "../../../shared/components/ui/AmountRow";
import { Label } from "../../../shared/components/ui/Label";
import { Pressable } from "../../../shared/components/ui/Pressable";
import type { DepositQuoteView } from "@peridotvault/pid-sdk-js";
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
        <AmountRow label="Amount" value={fmtIdr(quote.netIdr)} />
        {BigInt(transferFee) > 0n && <AmountRow label="Transfer Fee" value={fmtIdr(transferFee)} />}
        {Number(quote.appFeeIdr) > 0 && <AmountRow label="App Fee" value={fmtIdr(quote.appFeeIdr)} />}
        <AmountRow label="Total Payment" value={fmtIdr(selectedTotalIdr)} strong />
      </div>
      {editable && (
        <>
          <Label>Payment method</Label>
          <div className="flex flex-col mt-0.5 gap-1.5">
            {quote.paymentMethods.map((m) => (
              <Pressable
                key={m.key}
                onPress={() => onMethod(m.key)}
                accessibilityLabel={`Pay with ${m.label}`}
              >
                <div className={`flex flex-row w-full items-center justify-between rounded-lg border px-2.5 py-2 ${method === m.key ? "border-foreground" : "border-border"}`}>
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

