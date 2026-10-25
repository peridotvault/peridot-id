import { ScrollArea } from "../shared/components/ScrollArea";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { PushHeader } from "../shared/components/PushHeader";
import { UIButton } from "../shared/components/UIButton";
import { useNetworkMode } from "../shared/hooks/useNetworkMode";
import { useActivationGate } from "../feat/wallet/hooks/useActivationGate";
import { useCopyAddress } from "../feat/wallet/hooks/useCopyAddress";
import { DepositAddressCard } from "../feat/wallet/components/DepositAddressCard";
import { ActivationStatusCard } from "../feat/wallet/components/ActivationStatusCard";
import { flatten } from "../shared/styles";

export function ActivationScreen({ onDone, goPasskey }: { onDone: () => void; goPasskey: () => void }) {
  const { peridot } = usePeridot();
  const { solanaAvailable } = useNetworkMode();
  const gate = useActivationGate(peridot);
  const { copy, isCopied } = useCopyAddress();

  const copyAddress = () => {
    const addr = gate.activation?.smartAccountAddress;
    if (addr) void copy("address", addr);
  };

  // ANT-74 + ANT-78: the activation flow is Solana-specific; it renders only
  // when the data-driven gate passes (testnet always, mainnet only on a live
  // program via the ANT-75 registry signal). Otherwise this notice shows.
  if (!solanaAvailable) {
    return (
      <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
        <PushHeader onBack={onDone} title="Activate Account" />

        <div style={s.card} className="flex flex-col">
          <span className="font-sans text-sm leading-[19px] text-muted-foreground">
            Solana activation is available in Testnet Mode. Switch testnet ON to activate your on-chain account.
          </span>
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
      <PushHeader onBack={onDone} title="Activate Account" />

      <div style={s.card} className="flex flex-col">
        <span style={flatten([s.label, { marginBottom: 6 }])}>What happens</span>
        <span className="font-sans text-sm leading-[19px] text-muted-foreground">
          Activation creates your on-chain Solana account (the Peridot smart account / PDA).
          Until activated, your deposit address exists but has no on-chain account.
        </span>
      </div>

      <div style={s.card} className="flex flex-col">
        <span style={flatten([s.label, { marginBottom: 6 }])}>Who pays</span>
        <span className="font-sans text-sm leading-[19px] text-muted-foreground">
          The activation cost (rent + network fee + a small margin) is covered from the SOL
          in your own wallet at activation time. Peridot fronts the network fee from its own
          account and is reimbursed in the same transaction. There is no recurring
          sponsorship.
        </span>
      </div>

      {!gate.isActive && (
        <DepositAddressCard
          address={gate.activation?.smartAccountAddress ?? null}
          balanceSol={gate.balanceSol}
          requiredSol={gate.requiredSol}
          copied={isCopied("address")}
          onCopy={copyAddress}
        />
      )}

      {gate.error && <p role="alert" style={s.error}>{gate.error}</p>}

      {gate.activation && !gate.isActive && (
        <ActivationStatusCard status={gate.st} requiredSol={gate.requiredSol} balanceSol={gate.balanceSol} />
      )}

      {gate.isActive && (
        <div className="flex flex-col gap-1 border border-success bg-[#28c84014] p-3.5">
          <span className="font-sans text-base font-bold text-success">Account activated</span>
          <span className="font-sans text-sm leading-[19px] text-muted-foreground">
            Your smart account is live on-chain. The activation cost was reimbursed to
            Peridot from your deposit.
          </span>
        </div>
      )}

      {!gate.hasPasskey ? (
        <UIButton title="Create a passkey first" onPress={goPasskey} disabled={gate.busy} variant="primary" />
      ) : gate.ready ? (
        <UIButton title={gate.busy ? "Activating…" : "Activate Account"} onPress={gate.activate} disabled={gate.busy} variant="primary" />
      ) : (
        // ANT-333: hasPasskey but not ready yet (status still loading or
        // deposit unfunded) — never render a dead gap. The CTA stays
        // disabled and the hint says what is being waited on.
        <>
          <UIButton title="Activate Account" disabled variant="primary" />
          <span className="font-sans text-xs text-muted-foreground">
            {gate.activation
              ? "Waiting for enough SOL in the deposit address — activation unlocks automatically once funded."
              : "Checking activation status…"}
          </span>
        </>
      )}

      {gate.error && <span className="font-sans text-xs text-muted-foreground">Activation failures deduct nothing — your deposit stays in place. Retry if the message suggests so.</span>}
    </ScrollArea>
  );
}
