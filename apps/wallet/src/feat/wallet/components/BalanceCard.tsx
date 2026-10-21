import { Text, View } from "../../../shared/primitives";
import { styles as s } from "../../../shared/theme";
import { AsciiRidges } from "../../../shared/components/AsciiRidges";
import { UIButton } from "../../../shared/components/UIButton";
import { Plus } from "../../../shared/icons";
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
  onTopup,
}: {
  currency: Currency;
  totalValue: number;
  balanceIdr: string | null;
  balanceError: string | null;
  busy: boolean;
  rates: Rates | null;
  onRetry: () => void;
  onTopup: () => void;
}) {
  return (
    <View className="relative aspect-[1.586] overflow-hidden border border-border bg-background">
      {/* ponytail: AsciiRidges renders a full-window grid clipped by
          overflow hidden — same cost as login screens, card shows a center
          crop. Add cols/rows props only if the crop ever looks wrong. */}
      <View pointerEvents="none" className="absolute inset-0 overflow-hidden">
        <AsciiRidges exposure={0.6} gain={3} elementSize={14} opacity={1} layers={8} detail={3} />
        <View className="absolute inset-0 bg-black/10" />
      </View>
      <View className="flex-1 justify-between gap-1.5 p-5">
        {balanceError ? (
          <>
            <Text role="alert" style={s.error}>{balanceError}</Text>
            <UIButton title="Retry" onPress={onRetry} />
          </>
        ) : (
          <>
            <View className="gap-1.5">
              <Text className="font-sans text-[13px] text-muted-foreground">PeridotID</Text>
              <Text className="font-serif text-[38px] text-foreground">
                {busy && balanceIdr === null ? "…" : formatTotal(totalValue, currency)}
              </Text>
              <Text className="text-left font-mono text-sm font-medium text-foreground">
                {balanceIdr === null ? (busy ? "…" : "—") : formatIdrWhole(balanceIdr, "IDR", rates)}
              </Text>
            </View>
            <UIButton title="Top Up" icon={<Plus size={16} className="text-foreground" />} onPress={onTopup} />
          </>
        )}
      </View>
    </View>
  );
}
