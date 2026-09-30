import { StyleSheet, Text, View } from "react-native";
import { Info } from "../../../shared/icons";
import { theme, styles as s } from "../../../shared/theme";

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
      <View style={styles.statusRow}>
        <Info size={16} color={theme.colors.mutedForeground} />
        <Text style={styles.desc}>
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

const styles = StyleSheet.create({
  desc: { fontSize: 13, color: theme.colors.mutedForeground, lineHeight: 19, fontFamily: theme.fonts.sans },
  statusRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
});
