import { useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity } from "react-native";
import { usePeridot } from "../shared/AppContext";
import { theme, styles as s } from "../shared/theme";
import { useHomeData } from "../feat/wallet/hooks/useHomeData";
import { buildCoins, calcTotal } from "../feat/wallet/utils/assets";
import { BalanceCard } from "../feat/wallet/components/BalanceCard";
import { QuickActions } from "../feat/wallet/components/QuickActions";
import { SendChoiceModal } from "../feat/wallet/components/SendChoiceModal";
import { AssetSection } from "../feat/wallet/components/AssetSection";

interface HomeScreenProps {
  goSend: () => void;
  goReceive: () => void;
  goSwap: () => void;
  goBuy: () => void;
  goTransfer: () => void;
  goPasskeys: () => void;
}

export function HomeScreen({
  goSend,
  goReceive,
  goSwap,
  goBuy,
  goTransfer,
  goPasskeys,
}: HomeScreenProps) {
  const { peridot } = usePeridot();
  const d = useHomeData(peridot);
  const [choice, setChoice] = useState(false);
  const coins = buildCoins(d.solLamports, d.tokens);
  const totalValue = calcTotal({
    solLamports: d.solLamports,
    tokens: d.tokens,
    balanceIdr: d.balanceIdr,
    currency: d.currency,
    rates: d.rates,
  });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <BalanceCard
        currency={d.currency}
        totalValue={totalValue}
        balanceIdr={d.balanceIdr}
        balanceError={d.balanceError}
        busy={d.busy}
        rates={d.rates}
        onRetry={d.load}
        onTopup={goBuy}
      />

      <QuickActions onSend={() => setChoice(true)} onReceive={goReceive} onSwap={goSwap} onBuy={goBuy} />

      <SendChoiceModal
        visible={choice}
        activated={d.activated}
        onPickOnChain={() => {
          setChoice(false);
          goSend();
        }}
        onPickIdr={() => {
          setChoice(false);
          goTransfer();
        }}
        onClose={() => setChoice(false)}
      />

      {d.error && <Text style={s.error}>{d.error}</Text>}

      {d.activated && d.passkeys.length === 0 && !d.busy && (
        <TouchableOpacity style={styles.passkeyWarn} onPress={goPasskeys}>
          <Text style={styles.passkeyWarnText}>No passkey — add one in Security to authorize withdrawals.</Text>
        </TouchableOpacity>
      )}

      <AssetSection tab={d.assetTab} onTabChange={d.setAssetTab} coins={coins} nfts={d.nfts} busy={d.busy} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 14 },
  passkeyWarn: {
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 0,
    padding: 12,
  },
  passkeyWarnText: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center", fontFamily: theme.fonts.sans },
});
