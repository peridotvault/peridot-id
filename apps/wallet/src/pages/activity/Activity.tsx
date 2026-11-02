import { useState } from "react";
import { Pressable } from "../../shared/components/ui/Pressable";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { Cell, CellGrid } from "../../shared/components/ui/CellGrid";
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
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-4">
          <ActivityHeader tab={tab} onTabChange={setTab} onRefresh={() => { chain.reload(); fiat.reload(); }} busy={busy} />
        </SectionHead>
      </Section>

      {(chain.error || fiat.error) && (
        <Section className="border-t-danger/40 bg-danger/10">
          <SectionHead className="py-3">
            {chain.error && <p role="alert" className="font-sans text-sm text-foreground">{chain.error}</p>}
            {chain.error && <UIButton title="Retry" onPress={chain.reload} />}
            {fiat.error && <p role="alert" className="font-sans text-sm text-foreground">{fiat.error}</p>}
            {fiat.error && <UIButton title="Retry" onPress={fiat.reload} />}
          </SectionHead>
        </Section>
      )}

      <Section>
        {busy && <p role="status" style={s.hint} className="px-6 py-3">Loading…</p>}

        {tab !== "idr" && visible.length === 0 && !busy && (
          <p style={s.hint} className="px-6 py-3">No activity yet — send, receive, or activate your account to get started.</p>
        )}
        {tab === "idr" && visible.length === 0 && !busy && (
          <p style={s.hint} className="px-6 py-3">No IDR activity yet — top up to get started.</p>
        )}

        <div className="flex flex-col">
          {visible.map((item) => (
            <FeedRow
              key={rowKey(item)}
              item={item}
              onSelect={onSelect}
              onSelectFiat={onSelectFiat}
              onSelectLedger={onSelectLedger}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

function rowKey(item: AllItem): string {
  return item.type === "chain" ? item.tx.id : item.item.tx.id;
}

// Row dispatch: the union carries its own renderer — new feed kinds add a
// branch here, row internals stay in their owner feats.
function FeedRow({
  item,
  onSelect,
  onSelectFiat,
  onSelectLedger,
}: {
  item: AllItem;
  onSelect: (tx: WalletTransaction) => void;
  onSelectFiat: (item: FiatItem) => void;
  onSelectLedger: (item: FiatLedgerItem) => void;
}) {
  if (item.type === "chain") return <ChainRow tx={item.tx} onSelect={onSelect} />;
  if (item.type === "fiat") return <FiatRow item={item.item} onSelect={onSelectFiat} />;
  return <LedgerRow item={item.item} onSelect={onSelectLedger} />;
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
      <div style={{ flexDirection: "row" }} className="flex items-center justify-between">
        <h1 style={s.title}>Activity</h1>
        <Pressable onPress={onRefresh} disabled={busy} accessibilityLabel="Refresh activity">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface">
            <RefreshCw size={16} className="text-foreground" />
          </div>
        </Pressable>
      </div>

      <CellGrid cols="grid-cols-3" className="-mx-6 mt-4">
        <TabButton label="All" active={tab === "all"} onPress={() => onTabChange("all")} />
        <TabButton label="Onchain" active={tab === "onchain"} onPress={() => onTabChange("onchain")} />
        <TabButton label="IDR" active={tab === "idr"} onPress={() => onTabChange("idr")} />
      </CellGrid>
    </>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected: active }}
    >
      <Cell className={`flex w-full items-center justify-center py-2.5 transition-colors ${active ? "bg-secondary" : "bg-background hover:bg-surface"}`}>
        <span className={`font-sans text-sm font-medium ${active ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
      </Cell>
    </Pressable>
  );
}
