import { useState } from "react";
import { Text, View } from "../shared/primitives";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";
import { useNetworkMode } from "../shared/hooks/useNetworkMode";
import { useActivationGate } from "../feat/wallet/hooks/useActivationGate";
import { useCopyAddress } from "../feat/wallet/hooks/useCopyAddress";
import { useDepositTargets } from "../feat/wallet/hooks/useDepositTargets";
import { DepositCardList } from "../feat/wallet/components/DepositCardList";
import { SolActivationModal } from "../feat/wallet/components/SolActivationModal";
import type { DepositTarget } from "../feat/wallet/utils/deposit-targets";

export function ReceiveScreen({ onDone, goPasskey }: { onDone: () => void; goPasskey: () => void }) {
  const { peridot } = usePeridot();
  const { targets } = useDepositTargets(peridot);
  const { testnet } = useNetworkMode();
  const [selectedSol, setSelectedSol] = useState<DepositTarget | null>(null);
  const gate = useActivationGate(peridot);
  const { copiedKey, copy } = useCopyAddress();

  const openSol = (t: DepositTarget) => {
    // ANT-74: Solana entry is hidden in mainnet mode — ignore taps even if
    // a stale target lingers (e.g. mode switched with modal open).
    if (!testnet) return;
    gate.clearError();
    setSelectedSol(t);
    void gate.refresh();
  };

  return (
    <View style={s.container}>
      <Text style={s.title}>Receive</Text>
      <Text style={s.subtitle}>Share an address below. EVM chains share one address everywhere.</Text>

      {targets.length === 0 && <Text style={s.hint}>Account not initialized.</Text>}

      {!testnet && (
        <Text style={s.hint}>Solana deposits are available in Testnet Mode. EVM addresses below work as usual.</Text>
      )}

      <DepositCardList
        targets={targets}
        solAlert={testnet && !gate.isActive}
        copiedKey={copiedKey}
        onOpen={openSol}
        onCopy={copy}
      />

      <UIButton title="Back" onPress={onDone} />

      {testnet && (
        <SolActivationModal
          target={selectedSol}
          gate={gate}
          copiedKey={copiedKey}
          onClose={() => setSelectedSol(null)}
          onCopy={copy}
          onGoPasskey={goPasskey}
        />
      )}
    </View>
  );
}
