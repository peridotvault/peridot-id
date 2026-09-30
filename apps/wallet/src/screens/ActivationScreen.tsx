import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft, Rocket } from "../shared/icons";
import { usePeridot } from "../shared/AppContext";
import { theme, styles as s } from "../shared/theme";
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <View style={styles.titleRow}>
        <Rocket size={22} color={theme.colors.foreground} />
        <Text style={s.title}>Activate Account</Text>
      </View>

      <View style={s.card}>
        <Text style={[s.label, { marginBottom: 6 }]}>What happens</Text>
        <Text style={styles.desc}>
          Activation creates your on-chain Solana account (the Peridot smart account / PDA).
          Until activated, your deposit address exists but has no on-chain account.
        </Text>
      </View>

      <View style={s.card}>
        <Text style={[s.label, { marginBottom: 6 }]}>Who pays</Text>
        <Text style={styles.desc}>
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
        <View style={styles.activeCard}>
          <Text style={styles.activeTitle}>Account activated</Text>
          <Text style={styles.desc}>
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

      {gate.error && <Text style={styles.errHint}>Activation failures deduct nothing — your deposit stays in place. Retry if the message suggests so.</Text>}

      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 14 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  desc: { fontSize: 13, color: theme.colors.mutedForeground, lineHeight: 19, fontFamily: theme.fonts.sans },
  errHint: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  activeCard: {
    backgroundColor: theme.colors.success + "14",
    borderWidth: 1,
    borderColor: theme.colors.success,
    borderRadius: 0,
    padding: 14,
    gap: 4,
  },
  activeTitle: { fontSize: 15, fontWeight: "700", color: theme.colors.success, fontFamily: theme.fonts.sansBold },
});
