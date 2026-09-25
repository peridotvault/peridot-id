import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowDownLeft, ArrowUpRight, Rocket, ChevronRight, RefreshCw } from "../icons";
import type { FiatLedgerEntry, FiatDepositView } from "@peridotvault/pid-sdk-js";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";

const LAMPORTS_PER_SOL = 1e9;

type Tab = "all" | "onchain" | "idr";

export type FiatKind = "deposit" | "withdraw" | "transfer" | "debit" | "fee";

/** Ledger-backed fiat row. DOKU is the ledger; this is the reference log. */
export type FiatItem = { kind: FiatKind; createdAt: string; tx: FiatDepositView };

/** A fiat ledger entry row. */
export type LedgerKind = "deposit" | "transfer" | "adjust";
export type FiatLedgerItem = { kind: LedgerKind; createdAt: string; tx: FiatLedgerEntry };

type AllItem =
  | { type: "chain"; createdAt: string; tx: WalletTransaction }
  | { type: "fiat"; createdAt: string; item: FiatItem }
  | { type: "ledger"; createdAt: string; item: FiatLedgerItem };

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

/** Friendly status text — provider enums (settled/processing/...) never reach the user. */
export function fiatStatusLabel(kind: FiatKind, status: string): string {
  const incoming = kind === "deposit";
  switch (status) {
    case "success":
    case "settled":
      return incoming ? "Payment received" : "Completed";
    case "created":
    case "processing":
      return incoming ? "Waiting for payment" : "Processing";
    case "expired":
      return incoming ? "Payment expired" : "Expired";
    case "failed":
      return incoming ? "Payment failed" : "Failed";
    case "cancelled":
      return "Cancelled";
    case "refunded":
      return "Refunded";
    default:
      return "Pending";
  }
}

function ledgerKindOf(kind: string): LedgerKind {
  if (kind === "fiat_issue") return "deposit";
  if (kind === "fiat_adjust") return "adjust";
  return "transfer"; // fiat_transfer_in / fiat_transfer_out
}

function ledgerLabel(kind: LedgerKind, incoming: boolean): string {
  if (kind === "deposit") return "Deposit";
  if (kind === "adjust") return "Adjustment";
  return incoming ? "Transfer in" : "Transfer out";
}

export function ledgerStatusLabel(status: string): string {
  switch (status) {
    case "posted":
      return "Completed";
    case "created":
      return "Pending";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Pending";
  }
}

/** Pending deposits (DOKU intent rows not yet posted to the ledger). */
function pendingDeposit(tx: FiatDepositView): boolean {
  return tx.kind === "deposit" && (tx.providerStatus === "created" || tx.providerStatus === "processing");
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
  onSelectLedger,
}: {
  onSelect: (tx: WalletTransaction) => void;
  onSelectFiat: (item: FiatItem) => void;
  onSelectLedger: (item: FiatLedgerItem) => void;
}) {
  const { peridot } = usePeridot();
  const [tab, setTab] = useState<Tab>("all");
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [deposits, setDeposits] = useState<FiatDepositView[]>([]);
  const [entries, setEntries] = useState<FiatLedgerEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [chain, depositsView, ledgerView] = await Promise.all([
        peridot.wallet.history(),
        peridot.fiat.deposits().catch(() => [] as FiatDepositView[]),
        peridot.fiat.ledger().then((l) => l.rows).catch(() => [] as FiatLedgerEntry[]),
      ]);
      // Heal unsettled deposit intents against DOKU (local rows never self-heal).
      const healed = await Promise.all(
        depositsView
          .filter((x) => pendingDeposit(x))
          .map((x) => peridot.fiat.syncTransaction(x.id).catch(() => null)),
      );
      const fresh = new Map(healed.filter((x) => x !== null).map((x) => [x.id, x]));
      setItems((Array.isArray(chain) ? chain : []) as WalletTransaction[]);
      setDeposits(depositsView.map((x) => fresh.get(x.id) ?? x));
      setEntries(ledgerView);
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
  // IDR tab = pending DOKU deposit intents (not yet on the ledger) + the
  // fiat ledger. Issued deposits appear only as fiat_issue rows.
  const fiatItems: FiatItem[] = deposits
    .filter((tx) => pendingDeposit(tx))
    .map((tx): FiatItem => ({ kind: "deposit", createdAt: tx.createdAt, tx }))
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  const ledgerItems: FiatLedgerItem[] = entries
    .filter((tx) => tx.kind !== "fiat_fee")
    .map((tx): FiatLedgerItem => ({
      kind: ledgerKindOf(tx.kind),
      createdAt: tx.createdAt,
      tx,
    }))
    .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  const chainItems: AllItem[] = items.map((tx): AllItem => ({ type: "chain", createdAt: tx.createdAt, tx }));
  const fiatAll: AllItem[] = fiatItems.map((f): AllItem => ({ type: "fiat", createdAt: f.createdAt, item: f }));
  const ledgerAll: AllItem[] = ledgerItems.map((c): AllItem => ({ type: "ledger", createdAt: c.createdAt, item: c }));
  const idrAll = [...fiatAll, ...ledgerAll].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  const allItems = [...chainItems, ...idrAll].sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1));

  const visible: AllItem[] =
    tab === "all" ? allItems : tab === "onchain" ? chainItems : idrAll;

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
  const color = tx.providerStatus === "settled" || tx.providerStatus === "success" ? theme.colors.success : theme.colors.foreground;
  // Only live money gets a sign: failed/cancelled/expired moved nothing.
  const live = ["settled", "success", "processing", "created"].includes(tx.providerStatus);
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
          <Text style={styles.muted}>{fmtDate(item.createdAt)} · {fiatStatusLabel(item.kind, tx.providerStatus)}</Text>
        </View>
        <Text style={styles.amount}>{sign}{fmtIdr(moved)}</Text>
        <ChevronRight size={16} color={theme.colors.mutedForeground} />
      </View>
    </TouchableOpacity>
  );
}

function LedgerRow({ item, onSelect }: { item: FiatLedgerItem; onSelect: (item: FiatLedgerItem) => void }) {
  const { tx } = item;
  const incoming = tx.direction === "in";
  const posted = tx.status === "posted";
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const color = posted ? (incoming ? theme.colors.success : theme.colors.foreground) : theme.colors.mutedForeground;
  const amount = tx.amountIdr;
  // Only posted money gets a sign: pending/failed/cancelled moved nothing.
  const sign = posted ? (incoming ? "+" : "−") : "";
  return (
    <TouchableOpacity key={tx.id} style={s.card} onPress={() => onSelect(item)}>
      <View style={styles.row}>
        <View style={[styles.icon, { backgroundColor: color + "22" }]}>
          <Icon size={16} color={color} />
        </View>
        <View style={styles.meta}>
          <Text style={styles.label}>{ledgerLabel(item.kind, incoming)}</Text>
          <Text style={styles.muted}>{fmtDate(item.createdAt)} · {ledgerStatusLabel(tx.status)}</Text>
        </View>
        <Text style={styles.amount}>{sign}{fmtIdr(amount)}</Text>
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
