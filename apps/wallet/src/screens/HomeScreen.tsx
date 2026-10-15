import { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "../shared/primitives";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
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
        <TouchableOpacity onPress={goPasskeys}>
          <View className="border border-border bg-muted p-3">
            <Text className="text-center font-sans text-[13px] text-muted-foreground">No passkey — add one in Security to authorize withdrawals.</Text>
          </View>
        </TouchableOpacity>
      )}

      <AssetSection tab={d.assetTab} onTabChange={d.setAssetTab} coins={coins} nfts={d.nfts} busy={d.busy} />
    </ScrollView>
  );
}
