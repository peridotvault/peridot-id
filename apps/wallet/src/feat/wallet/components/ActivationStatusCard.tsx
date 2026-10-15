import { Text, View } from "../../../shared/primitives";
import { Info } from "../../../shared/icons";
import { styles as s } from "../../../shared/theme";

export function ActivationStatusCard({
  status,
  requiredSol,
  balanceSol,
}: {
  status: string | undefined;
  requiredSol: number;
  balanceSol: number;
}) {
  return (
    <View style={s.card}>
      <Text style={[s.label, { marginBottom: 6 }]}>Status</Text>
      <View style={{ flexDirection: "row" }} className="items-start gap-2">
        <Info size={16} className="text-muted-foreground" />
        <Text className="font-sans text-[13px] leading-[19px] text-muted-foreground">
          {status === "ready"
            ? `Ready to activate.`
            : status === "inactivated"
              ? "Deposit SOL to your address above first."
              : status === "insufficient"
                ? `Need at least ${requiredSol.toFixed(4)} SOL to cover activation (you have ${balanceSol.toFixed(4)}).`
                : status === "activating"
                  ? "Activating on-chain…"
                  : "Funds received — activation is checked shortly."}
        </Text>
      </View>
    </View>
  );
}
