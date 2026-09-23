import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowDownLeft, ArrowUpRight, Rocket, ChevronRight, RefreshCw } from "../icons";
import type { SubTxView } from "@peridotvault/pid-sdk-js";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";

const LAMPORTS_PER_SOL = 1e9;

type Tab = "all" | "onchain" | "idr";

export type FiatKind = "deposit" | "withdraw" | "transfer" | "debit" | "fee";

/** Ledger-backed fiat row. DOKU is the ledger; this is the reference log. */
export type FiatItem = { kind: FiatKind; createdAt: string; tx: SubTxView };

type AllItem = { createdAt: string; row: { kind: "chain"; tx: WalletTransaction } | FiatItem };

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

function fiatKindOf(kind: string): FiatKind {
  if (kind === "deposit" || kind === "points_issue") return "deposit";
  if (kind === "transfer_internal") return "transfer";
  if (kind === "debit" || kind === "debit_cancel" || kind === "points_clawback") return "debit";
  if (kind === "fee" || kind === "points_fee") return "fee";
  return "withdraw";
}

function fiatLabel(kind: FiatKind): string {
  switch (kind) {
    case "deposit": return "Deposit";
    case "transfer": return "Transfer";
    case "debit": return "Debit";
    case "fee": return "Service fee";
    default: return "Withdraw";
  }
}

function fmtAmount(t: WalletTransaction): string {
  if (t.amount == null) return "";
  const asset = t.asset === "SOL" ? "SOL" : t.asset;
  const value = Number(t.amount) / (t.asset === "SOL" ? LAMPORTS_PER_SOL : 1e6);
  const sign = t.direction === "in" ? "+" : t.direction === "out" ? "−" : "";
  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${asset}`;
}

function meta(t: WalletTransaction): { label: string; icon: typeof ArrowUpRight; color: string } {
  switch (t.type) {
    case "DEPOSIT":
      return { label: "Receive", icon: ArrowDownLeft, color: theme.colors.success };
    case "WITHDRAW":
      return { label: "Send", icon: ArrowUpRight, color: theme.colors.foreground };
    case "ACTIVATION":
      return { label: "Activation", icon: Rocket, color: theme.colors.foreground };
    default:
      return { label: "Transaction", icon: RefreshCw, color: theme.colors.mutedForeground };
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ActivityScreen({
  onSelect,
  onSelectFiat,
}: {
  onSelect: (tx: WalletTransaction) => void;
  onSelectFiat: (item: FiatItem) => void;
}) {
  const { peridot } = usePeridot();
  const [tab, setTab] = useState<Tab>("all");
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [fiat, setFiat] = useState<SubTxView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [chain, ledger] = await Promise.all([
        peridot.wallet.history(),
        peridot.fiat.ledger().catch(() => []),
      ]);
      // Heal unsettled rows against DOKU (local rows never self-heal).
      const healed = await Promise.all(
        ledger
          .filter((x) => x.providerStatus === "created" || x.providerStatus === "processing")
          .map((x) => peridot.fiat.syncTransaction(x.id).catch(() => null)),
      );
      const fresh = new Map(healed.filter((x) => x !== null).map((x) => [x.id, x]));
      setItems((Array.isArray(chain) ? chain : []) as WalletTransaction[]);
      setFiat(ledger.map((x) => fresh.get(x.id) ?? x));
    } catch (e) {
      setError(String(e));
      // Non-fatal: keep showing cached local history if the RPC is unreachable.
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  // Fee legs live in the DB (idempotency + audit) but never surface in the
  // user's feed — the parent deposit/transfer already shows fee + net.
  const fiatItems: FiatItem[] = fiat
    .filter((tx) => tx.kind !== "fee" && tx.kind !== "points_fee")
    .map((tx): FiatItem => ({
      kind: fiatKindOf(tx.kind),
      createdAt: tx.createdAt,
      tx,
    }))
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  const allItems: AllItem[] = [
    ...items.map((tx): AllItem => ({ createdAt: tx.createdAt, row: { kind: "chain", tx } })),
    ...fiatItems.map((f): AllItem => ({ createdAt: f.createdAt, row: f })),
  ].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  const visible: AllItem[] =
    tab === "all"
      ? allItems
      : tab === "onchain"
        ? items.map((tx): AllItem => ({ createdAt: tx.createdAt, row: { kind: "chain", tx } }))
        : fiatItems.map((f): AllItem => ({ createdAt: f.createdAt, row: f }));

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <View style={styles.headRow}>
        <Text style={s.title}>Activity</Text>
        <TouchableOpacity style={styles.iconBtn} onPress={load} disabled={busy}>
          <RefreshCw size={16} color={theme.colors.foreground} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabs}>
        <TabButton label="All" active={tab === "all"} onPress={() => setTab("all")} />
        <TabButton label="Onchain" active={tab === "onchain"} onPress={() => setTab("onchain")} />
        <TabButton label="IDR" active={tab === "idr"} onPress={() => setTab("idr")} />
      </View>

      {error && <Text style={s.error}>{error}</Text>}
      {busy && <Text style={s.hint}>Loading…</Text>}

      {tab !== "idr" && visible.length === 0 && !busy && (
        <Text style={s.hint}>No activity yet — send, receive, or activate your account to get started.</Text>
      )}
      {tab === "idr" && visible.length === 0 && !busy && (
        <Text style={s.hint}>No IDR activity yet — top up to get started.</Text>
      )}

      {visible.map((item) =>
        item.row.kind === "chain" ? (
          <ChainRow key={item.row.tx.id} tx={item.row.tx} onSelect={onSelect} />
        ) : (
          <FiatRow key={item.row.tx.id} item={item.row} onSelect={onSelectFiat} />
        ),
      )}
    </ScrollView>
  );
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      style={[styles.tab, active && styles.tabActive]}
      onPress={onPress}
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ChainRow({ tx: t, onSelect }: { tx: WalletTransaction; onSelect: (tx: WalletTransaction) => void }) {
  const m = meta(t);
  const Icon = m.icon;
  return (
    <TouchableOpacity key={t.id} style={s.card} onPress={() => onSelect(t)}>
      <View style={styles.row}>
        <View style={[styles.icon, { backgroundColor: m.color + "22" }]}>
          <Icon size={16} color={m.color} />
        </View>
        <View style={styles.meta}>
          <Text style={styles.label}>{m.label}</Text>
          <Text style={styles.muted}>{fmtDate(t.createdAt)} · {t.status}</Text>
        </View>
        {t.amount != null && <Text style={styles.amount}>{fmtAmount(t)}</Text>}
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </View>
    </TouchableOpacity>
  );
}

function FiatRow({ item, onSelect }: { item: FiatItem; onSelect: (item: FiatItem) => void }) {
  const incoming = item.kind === "deposit";
  const { tx } = item;
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const color = tx.providerStatus === "settled" ? theme.colors.success : theme.colors.foreground;
  // Only live money gets a sign: failed/cancelled moved nothing.
  const live = tx.providerStatus === "settled" || tx.providerStatus === "processing" || tx.providerStatus === "created";
  const sign = live ? (incoming ? "+" : "−") : "";
  // Fee rows move the fee, not the parent gross — show what actually moved.
  // Headline rule everywhere: show NET (what the user gets), fall back to
  // gross while unsettled.
  const moved = item.kind === "fee" ? (tx.feeIdr ?? tx.grossIdr) : (tx.netIdr ?? tx.grossIdr);
  return (
    <TouchableOpacity key={tx.id} style={s.card} onPress={() => onSelect(item)}>
      <View style={styles.row}>
        <View style={[styles.icon, { backgroundColor: color + "22" }]}>
          <Icon size={16} color={color} />
        </View>
        <View style={styles.meta}>
          <Text style={styles.label}>{fiatLabel(item.kind)}</Text>
          <Text style={styles.muted}>{fmtDate(item.createdAt)} · {tx.providerStatus}</Text>
        </View>
        <Text style={styles.amount}>{sign}{fmtIdr(moved)}</Text>
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 12 },
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
  },
  tabs: { flexDirection: "row", borderWidth: 1, borderColor: theme.colors.border },
  tab: { flex: 1, alignItems: "center", paddingVertical: 10, backgroundColor: theme.colors.background },
  tabActive: { backgroundColor: theme.colors.foreground },
  tabLabel: { fontSize: 13, fontWeight: "500", color: theme.colors.mutedForeground, fontFamily: theme.fonts.sansMedium },
  tabLabelActive: { color: theme.colors.background },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  meta: { flex: 1, gap: 2 },
  label: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  muted: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  amount: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.mono },
});
