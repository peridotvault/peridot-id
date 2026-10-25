import { useState } from "react";

import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { PushHeader } from "../shared/components/PushHeader";
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
  const { solanaAvailable } = useNetworkMode();
  const [selectedSol, setSelectedSol] = useState<DepositTarget | null>(null);
  const gate = useActivationGate(peridot);
  const { copiedKey, copy } = useCopyAddress();

  const openSol = (t: DepositTarget) => {
    // ANT-74 + ANT-78: Solana entry renders only when the data-driven gate
    // passes — ignore taps even if a stale target lingers (e.g. mode
    // switched with modal open).
    if (!solanaAvailable) return;
    gate.clearError();
    setSelectedSol(t);
    void gate.refresh();
  };

  return (
    <div style={s.container} className="flex flex-col">
      <PushHeader onBack={onDone} title="Receive" />
      <p style={s.subtitle}>Share an address below. EVM chains share one address everywhere.</p>

      {targets.length === 0 && <p style={s.hint}>Account not initialized.</p>}

      {!solanaAvailable && (
        <p style={s.hint}>Solana deposits are available in Testnet Mode. EVM addresses below work as usual.</p>
      )}

      <DepositCardList
        targets={targets}
        solAlert={solanaAvailable && !gate.isActive}
        copiedKey={copiedKey}
        onOpen={openSol}
        onCopy={copy}
      />


      {solanaAvailable && (
        <SolActivationModal
          target={selectedSol}
          gate={gate}
          copiedKey={copiedKey}
          onClose={() => setSelectedSol(null)}
          onCopy={copy}
          onGoPasskey={goPasskey}
        />
      )}
    </div>
  );
}
