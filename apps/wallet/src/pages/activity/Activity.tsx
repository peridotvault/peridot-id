import { useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { Pressable } from "../../shared/components/ui/Pressable";
import { UIButton } from "../../shared/components/ui/UIButton";
import { RefreshCw } from "../../shared/components/icons";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import type { FiatItem, FiatLedgerItem } from "../../shared/data/fiat";
import { useChainHistory } from "../../feat/chain/hooks/useChainHistory";
import { useFiatHistory } from "../../feat/fiat/hooks/useFiatHistory";
import { selectFiatItems, selectLedgerItems } from "../../feat/fiat/utils/history";
import { ChainRow } from "../../feat/chain/components/ChainRow";
import { FiatRow } from "../../feat/fiat/components/FiatRow";
import { LedgerRow } from "../../feat/fiat/components/LedgerRow";

type Tab = "all" | "onchain" | "idr";

type AllItem =
  | { type: "chain"; createdAt: string; tx: WalletTransaction }
  | { type: "fiat"; createdAt: string; item: FiatItem }
  | { type: "ledger"; createdAt: string; item: FiatLedgerItem };

const byNewest = (a: { createdAt: string }, b: { createdAt: string }) => (a.createdAt > b.createdAt ? -1 : 1);

// The merge is composition — the page's job. Chain rows come from feat/chain,
// IDR rows from feat/fiat; this screen only interleaves them by recency.
// IDR tab = pending DOKU deposit intents (not yet on the ledger) + the fiat
// ledger. Issued deposits appear only as fiat_issue rows.
function selectVisible(
  items: WalletTransaction[],
  fiatItems: FiatItem[],
  ledgerItems: FiatLedgerItem[],
  tab: Tab,
): AllItem[] {
  const chainItems: AllItem[] = items.map((tx): AllItem => ({ type: "chain", createdAt: tx.createdAt, tx }));
  const idrAll: AllItem[] = [
    ...fiatItems.map((f): AllItem => ({ type: "fiat", createdAt: f.createdAt, item: f })),
    ...ledgerItems.map((c): AllItem => ({ type: "ledger", createdAt: c.createdAt, item: c })),
  ].sort(byNewest);
  if (tab === "onchain") return chainItems;
  if (tab === "idr") return idrAll;
  return [...chainItems, ...idrAll].sort(byNewest);
}

export function Activity({
  onSelect,
  onSelectFiat,
  onSelectLedger,
}: {
  onSelect: (tx: WalletTransaction) => void;
  onSelectFiat: (item: FiatItem) => void;
  onSelectLedger: (item: FiatLedgerItem) => void;
}) {
  const { peridot } = usePeridot();
  const [tab, setTab] = useState<Tab>("all");
  const chain = useChainHistory(peridot);
  const fiat = useFiatHistory(peridot);
  const busy = chain.busy || fiat.busy;
  const visible = selectVisible(
    chain.items,
    selectFiatItems(fiat.deposits),
    selectLedgerItems(fiat.entries),
    tab,
  );

  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <ActivityHeader tab={tab} onTabChange={setTab} onRefresh={() => { chain.reload(); fiat.reload(); }} busy={busy} />

      {chain.error && <p role="alert" style={s.error}>{chain.error}</p>}
      {chain.error && <UIButton title="Retry" onPress={chain.reload} />}
      {fiat.error && <p role="alert" style={s.error}>{fiat.error}</p>}
      {fiat.error && <UIButton title="Retry" onPress={fiat.reload} />}
      {busy && <p role="status" style={s.hint}>Loading…</p>}

      {tab !== "idr" && visible.length === 0 && !busy && (
        <p style={s.hint}>No activity yet — send, receive, or activate your account to get started.</p>
      )}
      {tab === "idr" && visible.length === 0 && !busy && (
        <p style={s.hint}>No IDR activity yet — top up to get started.</p>
      )}

      {visible.map((item) =>
        item.type === "chain" ? (
          <ChainRow key={item.tx.id} tx={item.tx} onSelect={onSelect} />
        ) : item.type === "fiat" ? (
          <FiatRow key={item.item.tx.id} item={item.item} onSelect={onSelectFiat} />
        ) : (
          <LedgerRow key={item.item.tx.id} item={item.item} onSelect={onSelectLedger} />
        ),
      )}
    </ScrollArea>
  );
}

// Tab pills live here, not in a feat: the All/Onchain/IDR split is this
// screen's own composition (Home's bare-text Tabs variant stays separate).
function ActivityHeader({
  tab,
  onTabChange,
  onRefresh,
  busy,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <>
      <div style={{ flexDirection: "row" }} className="flex flex-col items-center justify-between">
        <h1 style={s.title}>Activity</h1>
        <Pressable onPress={onRefresh} disabled={busy} accessibilityLabel="Refresh activity">
          <div className="flex flex-col flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface">
            <RefreshCw size={16} className="text-foreground" />
          </div>
        </Pressable>
      </div>

      <div style={{ flexDirection: "row" }} className="flex flex-col border border-border">
        <TabButton label="All" active={tab === "all"} onPress={() => onTabChange("all")} />
        <TabButton label="Onchain" active={tab === "onchain"} onPress={() => onTabChange("onchain")} />
        <TabButton label="IDR" active={tab === "idr"} onPress={() => onTabChange("idr")} />
      </div>
    </>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected: active }}
      className="flex-1"
    >
      <div className={`flex flex-col w-full items-center py-2.5 ${active ? "bg-foreground" : "bg-background"}`}>
        <span className={`font-sans text-sm font-medium ${active ? "text-background" : "text-muted-foreground"}`}>{label}</span>
      </div>
    </Pressable>
  );
}
