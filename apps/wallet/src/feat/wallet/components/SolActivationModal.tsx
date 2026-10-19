import { Modal, Text, View } from "../../../shared/primitives";
import QRCode from "react-qr-code";
import { theme, styles as s } from "../../../shared/theme";
import { UIButton } from "../../../shared/components/UIButton";
import type { useActivationGate } from "../hooks/useActivationGate";
import type { DepositTarget } from "../utils/deposit-targets";
import { isSolanaAvailable } from "../../../shared/network-mode";

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
  // ANT-74: never render the Solana activate entry in mainnet mode (no
  // mainnet program exists). ReceiveScreen already skips mounting this modal
  // when Solana is unavailable; this guard covers any other caller.
  if (!isSolanaAvailable()) return null;
  return (
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-black/70 p-6">
        <View className="w-full max-w-[360px] gap-3 border border-border bg-surface p-5">
          <Text className="font-sans text-[15px] font-semibold">{target?.label}</Text>
          {target && (
            <View className="mb-2 self-center bg-foreground p-3">
              <QRCode value={target.qrValue} size={220} bgColor={theme.colors.foreground} fgColor={theme.colors.background} />
            </View>
          )}
          <Text selectable style={s.mono}>{target?.address}</Text>
          {!gate.isActive && (
            <Text className={gate.balanceSol < gate.requiredSol ? "font-sans text-xs text-danger" : ""} style={gate.balanceSol < gate.requiredSol ? undefined : s.hint}>
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
