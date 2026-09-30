import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Copy } from "../../../shared/icons";
import { theme, styles as s } from "../../../shared/theme";

export function DepositAddressCard({
  address,
  balanceSol,
  requiredSol,
  copied,
  onCopy,
}: {
  address: string | null;
  balanceSol: number;
  requiredSol: number;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <View style={s.card}>
      <Text style={[s.label, { marginBottom: 6 }]}>Your deposit address</Text>
      <Text style={styles.desc}>
        Send SOL to this address to fund your wallet and cover activation. The cost
        currently requires about {requiredSol.toFixed(4)} SOL.
      </Text>
      <TouchableOpacity style={styles.addressBox} onPress={onCopy}>
        <Text selectable style={[s.mono, styles.addressText]}>
          {address ? `${address.slice(0, 8)}…${address.slice(-8)}` : "—"}
        </Text>
        {copied ? (
          <Text style={styles.copied}>Copied</Text>
        ) : (
          <Copy size={14} color={theme.colors.mutedForeground} />
        )}
      </TouchableOpacity>
      <Text style={s.hint}>
        Balance: {balanceSol.toFixed(4)} SOL{balanceSol < requiredSol ? ` — top up to at least ${requiredSol.toFixed(4)} SOL` : ""}.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  desc: { fontSize: 13, color: theme.colors.mutedForeground, lineHeight: 19, fontFamily: theme.fonts.sans },
  addressBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.muted,
    borderRadius: 0,
    marginTop: 4,
  },
  addressText: { flex: 1 },
  copied: { fontSize: 12, color: theme.colors.success, fontFamily: theme.fonts.sans },
});
