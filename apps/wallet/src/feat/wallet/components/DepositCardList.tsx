import { Text, TouchableOpacity, View } from "../../../shared/primitives";
import { Check } from "../../../shared/icons";
import { styles as s } from "../../../shared/theme";
import type { DepositTarget } from "../utils/deposit-targets";

export function DepositCardList({
  targets,
  solAlert,
  copiedKey,
  onOpen,
  onCopy,
}: {
  targets: DepositTarget[];
  /** True while the SOL account is not yet active (red alert styling). */
  solAlert: boolean;
  copiedKey: string | null;
  onOpen: (t: DepositTarget) => void;
  onCopy: (key: string, address: string) => void;
}) {
  return (
    <>
      {targets.map((t) => {
        const isSol = t.key.startsWith("solana-");
        const alert = isSol && solAlert;
        return (
          <View key={t.key} className={`mt-4 border bg-surface p-3 ${alert ? "border-danger" : "border-border"}`}>
            <View style={{ flexDirection: "row" }} className="mb-2 items-baseline justify-between">
              <Text className="font-sans text-[15px] font-semibold">{t.label}</Text>
              <Text style={s.hint}>{t.sublabel}</Text>
            </View>
            {alert && <Text className="mb-2 font-sans text-xs font-medium text-danger">Top up here to activate</Text>}
            <TouchableOpacity
              onPress={() => (isSol ? onOpen(t) : onCopy(t.key, t.address))}
            >
              <View style={{ flexDirection: "row" }} className="w-full items-center justify-between gap-2 border border-border bg-background p-3">
                <Text selectable style={s.mono}>{t.address}</Text>
                {copiedKey === t.key && <Check size={16} className="text-success" />}
              </View>
            </TouchableOpacity>
            {copiedKey === t.key && <Text className="text-center font-sans text-[13px] text-success">Copied to clipboard</Text>}
          </View>
        );
      })}
    </>
  );
}
