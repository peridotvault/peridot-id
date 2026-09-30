import { StyleSheet, Text, View } from "react-native";
import { theme, styles as s } from "../../../shared/theme";
import { AsciiRidges } from "../../../shared/components/AsciiRidges";
import { UIButton } from "../../../shared/components/UIButton";
import {
  formatIdrWhole,
  formatTotal,
  type Currency,
  type Rates,
} from "../../../shared/currency";

// All-Balance hero card: total (fiat + crypto in the selected currency) with
// the fiat leg below. Fiat stays pinned to IDR by product rule.
export function BalanceCard({
  currency,
  totalValue,
  balanceIdr,
  balanceError,
  busy,
  rates,
  onRetry,
  onTransfer,
}: {
  currency: Currency;
  totalValue: number;
  balanceIdr: string | null;
  balanceError: string | null;
  busy: boolean;
  rates: Rates | null;
  onRetry: () => void;
  onTransfer: () => void;
}) {
  return (
    <View style={styles.balanceCard}>
      {/* ponytail: native AsciiRidges renders a full-window grid clipped by
          overflow hidden — same cost as login screens, card shows a center
          crop. Add cols/rows props only if the crop ever looks wrong. */}
      <View style={styles.balanceCardBg} pointerEvents="none">
        <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
        <View style={styles.balanceCardVeil} />
      </View>
      <View style={styles.balanceCardContent}>
        <Text style={styles.fiatLabel}>All Balance · {currency}</Text>
        {balanceError ? (
          <>
            <Text style={s.error}>{balanceError}</Text>
            <UIButton title="Retry" onPress={onRetry} />
          </>
        ) : (
          <>
            <Text style={styles.fiatAmount}>
              {busy && balanceIdr === null ? "…" : formatTotal(totalValue, currency)}
            </Text>
            <View style={styles.breakdown}>
              <Text style={styles.fiatLeft}>
                {balanceIdr === null ? (busy ? "…" : "—") : formatIdrWhole(balanceIdr, "IDR", rates)}
              </Text>
              {!rates && !busy && (
                <Text style={s.hint}>Prices unavailable — total excludes crypto.</Text>
              )}
            </View>
            <UIButton title="Transfer" onPress={onTransfer} />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  balanceCard: {
    position: "relative",
    overflow: "hidden",
    aspectRatio: 1.586,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  balanceCardBg: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
  },
  balanceCardVeil: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10, 10, 10, 0.55)",
  },
  balanceCardContent: {
    flex: 1,
    justifyContent: "space-between",
    padding: 16,
    gap: 6,
  },
  fiatLabel: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  fiatAmount: { fontSize: 38, fontWeight: "400", color: theme.colors.foreground, fontFamily: theme.fonts.serif },
  breakdown: { gap: 2, paddingVertical: 4 },
  fiatLeft: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.mono, textAlign: "left" },
});
