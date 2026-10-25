import { useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { Pressable } from "../../shared/components/ui/Pressable";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { useHomeData } from "../../feat/wallet/hooks/useHomeData";
import { buildCoins, calcTotal } from "../../feat/wallet/utils/assets";
import { TotalBalanceSection } from "../../feat/wallet/components/TotalBalanceSection";
import { FiatSection } from "../../feat/fiat/components/FiatSection";
import { QuickActions } from "../../feat/wallet/components/QuickActions";
import { SendChoiceModal } from "../../feat/wallet/components/SendChoiceModal";
import { AssetSection } from "../../feat/wallet/components/AssetSection";

interface HomeProps {
  goSend: () => void;
  goReceive: () => void;
  goSwap: () => void;
  goBuy: () => void;
  goTransfer: () => void;
  goRupiah: () => void;
  goPasskeys: () => void;
}

export function Home({
  goSend,
  goReceive,
  goSwap,
  goBuy,
  goTransfer,
  goRupiah,
  goPasskeys,
}: HomeProps) {
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
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
      <TotalBalanceSection
        currency={d.currency}
        totalValue={totalValue}
        loading={d.busy && d.balanceIdr === null}
      />
      <QuickActions onSend={() => setChoice(true)} onReceive={goReceive} onSwap={goSwap} onBuy={goBuy} />
      <FiatSection
        balanceIdr={d.balanceIdr}
        balanceError={d.balanceError}
        busy={d.busy}
        onRetry={d.load}
        onOpen={goRupiah}
      />

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

      {d.error && <p role="alert" style={s.error}>{d.error}</p>}

      {d.activated && d.passkeys.length === 0 && !d.busy && (
        <Pressable onPress={goPasskeys} accessibilityLabel="Add a passkey in Security">
          <div className="flex flex-col border border-border bg-muted p-3">
            <span className="text-center font-sans text-sm text-muted-foreground">No passkey — add one in Security to authorize withdrawals.</span>
          </div>
        </Pressable>
      )}

      <AssetSection tab={d.assetTab} onTabChange={d.setAssetTab} coins={coins} nfts={d.nfts} busy={d.busy} />
    </ScrollArea>
  );
}
