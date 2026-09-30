import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Check } from "../../../shared/icons";
import { theme, styles as s } from "../../../shared/theme";
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
        return (
          <View key={t.key} style={[styles.card, isSol && solAlert && styles.solCardAlert]}>
            <View style={styles.cardHead}>
              <Text style={styles.chainLabel}>{t.label}</Text>
              <Text style={s.hint}>{t.sublabel}</Text>
            </View>
            {isSol && solAlert && <Text style={styles.solHint}>Top up here to activate</Text>}
            <TouchableOpacity
              style={styles.addressBox}
              onPress={() => (isSol ? onOpen(t) : onCopy(t.key, t.address))}
            >
              <Text selectable style={s.mono}>{t.address}</Text>
              {copiedKey === t.key && <Check size={16} color={theme.colors.success} />}
            </TouchableOpacity>
            {copiedKey === t.key && <Text style={styles.copied}>Copied to clipboard</Text>}
          </View>
        );
      })}
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: 0,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  chainLabel: { fontSize: 15, fontWeight: "600", fontFamily: theme.fonts.sans },
  addressBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    borderRadius: 0,
  },
  copied: { color: theme.colors.success, fontSize: 13, textAlign: "center", fontFamily: theme.fonts.sans },
  solCardAlert: {
    borderColor: theme.colors.danger,
  },
  solHint: { fontSize: 12, color: theme.colors.danger, fontFamily: theme.fonts.sansMedium, marginBottom: 8 },
});
