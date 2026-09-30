import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { DepositQuoteView } from "@peridotvault/pid-sdk-js";
import { theme, styles as s } from "../../../shared/theme";
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
      <View style={styles.breakdown}>
        <Row label="Amount" value={fmtIdr(quote.netIdr)} />
        {BigInt(transferFee) > 0n && <Row label="Transfer Fee" value={fmtIdr(transferFee)} />}
        {Number(quote.appFeeIdr) > 0 && <Row label="App Fee" value={fmtIdr(quote.appFeeIdr)} />}
        <Row label="Total Payment" value={fmtIdr(selectedTotalIdr)} strong />
      </View>
      {editable && (
        <>
          <Text style={s.label}>Payment method</Text>
          <View style={styles.methods}>
            {quote.paymentMethods.map((m) => (
              <TouchableOpacity
                key={m.key}
                style={[styles.method, method === m.key && styles.methodActive]}
                onPress={() => onMethod(m.key)}
                accessibilityLabel={`Pay with ${m.label}`}
              >
                <Text style={[styles.methodLabel, method === m.key && styles.methodLabelActive]}>{m.label}</Text>
                {m.enabled && <Text style={styles.methodFee}>{fmtIdr(sumIdr(m.gatewayFeeIdr, m.gatewayTaxIdr))}</Text>}
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
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && styles.strong]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  breakdown: { marginTop: 8, gap: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowLabel: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  rowValue: { fontSize: 13, color: theme.colors.foreground, fontFamily: theme.fonts.mono },
  strong: { fontWeight: "700", color: theme.colors.foreground },
  methods: { gap: 6, marginTop: 2 },
  method: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  methodActive: { borderColor: theme.colors.foreground },
  methodLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  methodLabelActive: { fontWeight: "600" },
  methodFee: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.mono },
});
