import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowDownLeft, ArrowUpRight, Banknote, Coins } from "../../../shared/icons";
import { theme } from "../../../shared/theme";

export function QuickActions({
  activated,
  onSend,
  onReceive,
  onSwap,
  onBuy,
}: {
  activated: boolean;
  onSend: () => void;
  onReceive: () => void;
  onSwap: () => void;
  onBuy: () => void;
}) {
  return (
    <View style={styles.actions}>
      <ActionButton icon={ArrowUpRight} label="Send" onPress={onSend} disabled={!activated} />
      <ActionButton icon={ArrowDownLeft} label="Receive" onPress={onReceive} />
      <ActionButton icon={Coins} label="Swap" onPress={onSwap} />
      <ActionButton icon={Banknote} label="Buy" onPress={onBuy} />
    </View>
  );
}

function ActionButton({ icon: Icon, label, onPress, disabled }: { icon: typeof ArrowUpRight; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, disabled && styles.actionBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled }}
    >
      <View style={styles.actionIcon}>
        <Icon size={20} color={disabled ? theme.colors.mutedForeground : theme.colors.foreground} />
      </View>
      <Text style={[styles.actionLabel, disabled && styles.actionLabelDisabled]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row", gap: 12 },
  actionBtn: {
    flex: 1,
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  actionBtnDisabled: { opacity: 0.4 },
  actionLabelDisabled: { opacity: 0.6 },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: { fontSize: 13, color: theme.colors.foreground, fontWeight: "500", fontFamily: theme.fonts.sansMedium },
});
