import { useState } from "react";
import { Section, SectionHead } from "../../shared/components/ui/Section";

import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { Retry } from "../../shared/components/ui/Retry";
import { useNetworkMode } from "../../shared/hooks/useNetworkMode";
import { getSelection } from "../../shared/data/selectedChains";
import { useActivationGate } from "../../feat/chain/hooks/useActivationGate";
import { useCopyAddress } from "../../feat/chain/hooks/useCopyAddress";
import { useDepositTargets } from "../../feat/chain/hooks/useDepositTargets";
import { DepositCardList } from "../../feat/chain/components/DepositCardList";
import { SolActivationModal } from "../../feat/chain/components/SolActivationModal";
import type { DepositTarget } from "../../feat/chain/utils/depositTargets";

export function Receive({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const { targets, reload, loading, error } = useDepositTargets(peridot);
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

  // Never claim "not initialized" on an empty list: the account can exist and
  // still have no row (no registered passkey, no deployable contract pair, or
  // a chain selection that excludes every row).
  const emptyHint =
    getSelection().mode === "custom"
      ? "No deposit addresses for the chains you selected — change them in Settings → Chains."
      : !gate.hasPasskey
        ? "Add a passkey (Profile → Passkey) to create your deposit addresses."
        : "No chain is ready for deposits yet.";

  return (
    <div className="flex flex-1 flex-col">
      <Section className="border-t-0">
        <SectionHead className="flex flex-col gap-4 pb-8">
          <PushHeader onBack={onDone} title="Receive" />
          <p style={s.subtitle}>Share an address below. EVM chains share one address everywhere.</p>

          {loading && targets.length === 0 && <p style={s.hint}>Loading deposit addresses…</p>}

          {!loading && error && (
            <>
              <p role="alert" style={s.hint}>
                Couldn&apos;t load deposit addresses ({error}).
              </p>
              <Retry onPress={reload} label="Retry loading deposit addresses" />
            </>
          )}

          {!loading && !error && targets.length === 0 && <p style={s.hint}>{emptyHint}</p>}

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
            />
          )}
        </SectionHead>
      </Section>
    </div>
  );
}
