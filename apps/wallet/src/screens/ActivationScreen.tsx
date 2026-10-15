import { ScrollView, Text, View } from "../shared/primitives";
import { Rocket } from "../shared/icons";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";
import { UIButton } from "../shared/components/UIButton";
import { useActivationGate } from "../feat/wallet/hooks/useActivationGate";
import { useCopyAddress } from "../feat/wallet/hooks/useCopyAddress";
import { DepositAddressCard } from "../feat/wallet/components/DepositAddressCard";
import { ActivationStatusCard } from "../feat/wallet/components/ActivationStatusCard";

export function ActivationScreen({ onDone, goPasskey }: { onDone: () => void; goPasskey: () => void }) {
  const { peridot } = usePeridot();
  const gate = useActivationGate(peridot);
  const { copy, isCopied } = useCopyAddress();

  const copyAddress = () => {
    const addr = gate.activation?.smartAccountAddress;
    if (addr) void copy("address", addr);
  };

  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
      <BackButton onPress={onDone} />

      <View style={{ flexDirection: "row" }} className="items-center gap-2.5">
        <Rocket size={22} className="text-foreground" />
        <Text style={s.title}>Activate Account</Text>
      </View>

      <View style={s.card}>
        <Text style={[s.label, { marginBottom: 6 }]}>What happens</Text>
        <Text className="font-sans text-[13px] leading-[19px] text-muted-foreground">
          Activation creates your on-chain Solana account (the Peridot smart account / PDA).
          Until activated, your deposit address exists but has no on-chain account.
        </Text>
      </View>

      <View style={s.card}>
        <Text style={[s.label, { marginBottom: 6 }]}>Who pays</Text>
        <Text className="font-sans text-[13px] leading-[19px] text-muted-foreground">
          The activation cost (rent + network fee + a small margin) is covered from the SOL
          in your own wallet at activation time. Peridot fronts the network fee from its own
          account and is reimbursed in the same transaction. There is no recurring
          sponsorship.
        </Text>
      </View>

      {!gate.isActive && (
        <DepositAddressCard
          address={gate.activation?.smartAccountAddress ?? null}
          balanceSol={gate.balanceSol}
          requiredSol={gate.requiredSol}
          copied={isCopied("address")}
          onCopy={copyAddress}
        />
      )}

      {gate.error && <Text style={s.error}>{gate.error}</Text>}

      {gate.activation && !gate.isActive && (
        <ActivationStatusCard status={gate.st} requiredSol={gate.requiredSol} balanceSol={gate.balanceSol} />
      )}

      {gate.isActive && (
        <View className="gap-1 border border-success bg-[#28c84014] p-3.5">
          <Text className="font-sans text-[15px] font-bold text-success">Account activated</Text>
          <Text className="font-sans text-[13px] leading-[19px] text-muted-foreground">
            Your smart account is live on-chain. The activation cost was reimbursed to
            Peridot from your deposit.
          </Text>
        </View>
      )}

      {!gate.hasPasskey ? (
        <UIButton title="Create a passkey first" onPress={goPasskey} disabled={gate.busy} variant="primary" />
      ) : gate.ready ? (
        <UIButton title={gate.busy ? "Activating…" : "Activate Account"} onPress={gate.activate} disabled={gate.busy} variant="primary" />
      ) : null}

      {gate.error && <Text className="font-sans text-xs text-muted-foreground">Activation failures deduct nothing — your deposit stays in place. Retry if the message suggests so.</Text>}

      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}
