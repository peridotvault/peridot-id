import { useSyncExternalStore } from "react";
import { Modal } from "../../../shared/components/ui/Modal";
import QRCode from "react-qr-code";
import { theme, styles as s } from "../../../shared/styles/theme";
import { UIButton } from "../../../shared/components/ui/UIButton";
import { ActivationFee } from "./ActivationFee";
import type { useActivationGate } from "../hooks/useActivationGate";
import type { DepositTarget } from "../utils/depositTargets";
import { isSolanaAvailable, subscribeNetworkMode } from "../../../shared/data/networkMode";

type Gate = ReturnType<typeof useActivationGate>;

export function SolActivationModal({
  target,
  gate,
  copiedKey,
  onClose,
  onCopy,
}: {
  target: DepositTarget | null;
  gate: Gate;
  copiedKey: string | null;
  onClose: () => void;
  onCopy: (key: string, address: string) => void;
}) {
  // ANT-74 + ANT-78: never render the Solana activate entry unless the
  // data-driven gate passes (testnet always; mainnet only when the registry
  // signal reports available). Subscribes so a late-resolving fetch
  // re-renders instead of sticking hidden. ReceiveScreen already skips
  // mounting this modal when Solana is unavailable; this guard covers any
  // other caller.
  const solanaAvailable = useSyncExternalStore(
    subscribeNetworkMode,
    isSolanaAvailable,
    isSolanaAvailable,
  );
  if (!solanaAvailable) return null;
  return (
    <Modal visible={target !== null} transparent animationType="fade" onRequestClose={onClose}>
      <div className="flex flex-col flex-1 items-center justify-center bg-black/70 p-6">
        <div className="flex flex-col w-full max-w-[360px] gap-3 border border-border bg-surface p-5">
          <span className="font-sans text-base font-semibold">{target?.label}</span>
          {target && (
            <div className="flex flex-col mb-2 self-center bg-foreground p-3">
              <QRCode value={target.qrValue} size={220} bgColor={theme.colors.foreground} fgColor={theme.colors.background} />
            </div>
          )}
          <span style={s.mono} className="select-text">{target?.address}</span>
          {!gate.isActive && (
            <span className={gate.balanceSol < gate.requiredSol ? "font-sans text-xs text-danger" : ""} style={gate.balanceSol < gate.requiredSol ? undefined : s.hint}>
              Balance: {gate.balanceSol.toFixed(4)} SOL{gate.balanceSol < gate.requiredSol ? ` — top up to at least ${gate.requiredSol.toFixed(4)} SOL` : ""}.
            </span>
          )}
          {!gate.isActive && !gate.ready && (
            <p style={s.hint}>
              {gate.st === "insufficient"
                ? `Need at least ${gate.requiredSol.toFixed(4)} SOL to cover the first-send setup (you have ${gate.balanceSol.toFixed(4)}).`
                : gate.st === "activating"
                  ? "Setting up on-chain…"
                  : "Send SOL to this address first."}
            </p>
          )}
          {gate.error && <p role="alert" style={s.error}>{gate.error}</p>}
          {!gate.isActive && gate.activation && <ActivationFee view={gate.activation} />}
          {/* ANT-731 WS4: no separate setup step — the first send sets the
              account up automatically inside the send flow. This modal stays
              a funding view (address + QR + balance), never a CTA. */}
          {!gate.isActive && (
            <p style={s.hint}>
              No setup step needed — your first send sets up this account automatically.
            </p>
          )}
          <UIButton
            title={target && copiedKey === target.key ? "Copied" : "Copy address"}
            onPress={() => target && onCopy(target.key, target.address)}
          />
          <UIButton title="Close" onPress={onClose} />
        </div>
      </div>
    </Modal>
  );
}
