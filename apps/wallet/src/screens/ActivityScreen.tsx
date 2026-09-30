import { useState } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { usePeridot } from "../shared/AppContext";
import { theme, styles as s } from "../shared/theme";
import type { FiatItem, FiatLedgerItem } from "../shared/fiat";
import { useActivityFeed } from "../feat/activity/hooks/useActivityFeed";
import {
  selectFiatItems,
  selectLedgerItems,
  selectVisible,
  type Tab,
} from "../feat/activity/utils/feed";
import { ActivityHeader } from "../feat/activity/components/ActivityHeader";
import { ChainRow } from "../feat/activity/components/ChainRow";
import { FiatRow } from "../feat/activity/components/FiatRow";
import { LedgerRow } from "../feat/activity/components/LedgerRow";

export function ActivityScreen({
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
  const feed = useActivityFeed(peridot);
  const visible = selectVisible(
    feed.items,
    selectFiatItems(feed.deposits),
    selectLedgerItems(feed.entries),
    tab,
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <ActivityHeader tab={tab} onTabChange={setTab} onRefresh={feed.reload} busy={feed.busy} />

      {feed.error && <Text style={s.error}>{feed.error}</Text>}
      {feed.busy && <Text style={s.hint}>Loading…</Text>}

      {tab !== "idr" && visible.length === 0 && !feed.busy && (
        <Text style={s.hint}>No activity yet — send, receive, or activate your account to get started.</Text>
      )}
      {tab === "idr" && visible.length === 0 && !feed.busy && (
        <Text style={s.hint}>No IDR activity yet — top up to get started.</Text>
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 12 },
});
