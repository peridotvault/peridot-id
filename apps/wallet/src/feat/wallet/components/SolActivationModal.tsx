import { Modal, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { theme, styles as s } from "../../../shared/theme";
import { UIButton } from "../../../shared/components/UIButton";
import type { useActivationGate } from "../hooks/useActivationGate";
import type { DepositTarget } from "../utils/deposit-targets";

type Gate = ReturnType<typeof useActivationGate>;

export function SolActivationModal({
  target,
  gate,
  copiedKey,
  onClose,
  onCopy,
  onGoPasskey,
}: {
  target: DepositTarget | null;
  gate: Gate;
  copiedKey: string | null;
  onClose: () => void;
  onCopy: (key: string, address: string) => void;
  onGoPasskey: () => void;
}) {
  return (
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalScrim}>
        <View style={styles.modalCard}>
          <Text style={styles.chainLabel}>{target?.label}</Text>
          {target && (
            <View style={styles.qrWrap}>
              <QRCode value={target.qrValue} size={220} backgroundColor={theme.colors.foreground} color={theme.colors.background} />
            </View>
          )}
          <Text selectable style={s.mono}>{target?.address}</Text>
          {!gate.isActive && (
            <Text style={gate.balanceSol < gate.requiredSol ? styles.balanceAlert : s.hint}>
              Balance: {gate.balanceSol.toFixed(4)} SOL{gate.balanceSol < gate.requiredSol ? ` — top up to at least ${gate.requiredSol.toFixed(4)} SOL` : ""}.
            </Text>
          )}
          {!gate.isActive && !gate.ready && (
            <Text style={s.hint}>
              {gate.st === "insufficient"
                ? `Need at least ${gate.requiredSol.toFixed(4)} SOL to cover activation (you have ${gate.balanceSol.toFixed(4)}).`
                : gate.st === "activating"
                  ? "Activating on-chain…"
                  : "Send SOL to this address first."}
            </Text>
          )}
          {gate.error && <Text style={s.error}>{gate.error}</Text>}
          {!gate.isActive && (
            <UIButton
              title={gate.busy ? "Activating…" : "Activate Account"}
              variant="primary"
              // ponytail: passkey is a hard backend requirement (the claim
              // must be passkey-signed), so one button routes both cases:
              // no passkey → create one first, else activate inline.
              // Disabled (not hidden) when under-funded — the hint above
              // explains why.
              onPress={() => (gate.hasPasskey ? gate.activate() : onGoPasskey())}
              disabled={gate.busy || !gate.ready}
            />
          )}
          <UIButton
            title={target && copiedKey === target.key ? "Copied" : "Copy address"}
            onPress={() => target && onCopy(target.key, target.address)}
          />
          <UIButton title="Close" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chainLabel: { fontSize: 15, fontWeight: "600", fontFamily: theme.fonts.sans },
  qrWrap: {
    alignSelf: "center",
    padding: 12,
    backgroundColor: theme.colors.foreground,
    borderRadius: 0,
    marginBottom: 8,
  },
  balanceAlert: { fontSize: 12, color: theme.colors.danger, fontFamily: theme.fonts.sans },
  modalScrim: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 360,
    gap: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: 0,
  },
});
