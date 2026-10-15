import { Text, TouchableOpacity, View } from "../../../shared/primitives";
import type { DepositQuoteView } from "@peridotvault/pid-sdk-js";
import { styles as s } from "../../../shared/theme";
import { fmtIdr, sumIdr } from "../../../shared/fiat";

// Single copy of the DOKU-checkout quote UI shared by TopupScreen and
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
      <View className="mt-2 gap-1">
        <Row label="Amount" value={fmtIdr(quote.netIdr)} />
        {BigInt(transferFee) > 0n && <Row label="Transfer Fee" value={fmtIdr(transferFee)} />}
        {Number(quote.appFeeIdr) > 0 && <Row label="App Fee" value={fmtIdr(quote.appFeeIdr)} />}
        <Row label="Total Payment" value={fmtIdr(selectedTotalIdr)} strong />
      </View>
      {editable && (
        <>
          <Text style={s.label}>Payment method</Text>
          <View className="mt-0.5 gap-1.5">
            {quote.paymentMethods.map((m) => (
              <TouchableOpacity
                key={m.key}
                onPress={() => onMethod(m.key)}
                accessibilityLabel={`Pay with ${m.label}`}
              >
                <View style={{ flexDirection: "row" }} className={`w-full items-center justify-between border px-2.5 py-2 ${method === m.key ? "border-foreground" : "border-border"}`}>
                  <Text className={`font-sans text-sm text-foreground ${method === m.key ? "font-semibold" : ""}`}>{m.label}</Text>
                  {m.enabled && <Text className="font-mono text-[13px] text-muted-foreground">{fmtIdr(sumIdr(m.gatewayFeeIdr, m.gatewayTaxIdr))}</Text>}
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}
    </>
  );
}

/** One label/value line of the quote breakdown. */
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={{ flexDirection: "row" }} className="items-center justify-between">
      <Text className={`font-sans text-[13px] ${strong ? "font-bold text-foreground" : "text-muted-foreground"}`}>{label}</Text>
      <Text className={`font-mono text-[13px] text-foreground ${strong ? "font-bold" : ""}`}>{value}</Text>
    </View>
  );
}
