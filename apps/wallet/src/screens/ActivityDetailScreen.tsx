import { Linking, ScrollView, Text, View } from "../shared/primitives";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { styles as s } from "../shared/theme";
import { solanaExplorerTxUrl } from "../shared/network-mode";
import { BackButton } from "../shared/components/BackButton";
import { UIButton } from "../shared/components/UIButton";

const LAMPORTS_PER_SOL = 1e9;

function fmtAmount(t: WalletTransaction): string {
  if (t.amount == null) return "—";
  const value = Number(t.amount) / (t.asset === "SOL" ? LAMPORTS_PER_SOL : 1e6);
  const sign = t.direction === "in" ? "+" : t.direction === "out" ? "-" : "";
  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${t.asset === "SOL" ? "SOL" : t.asset}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function ActivityDetailScreen({ tx, onDone }: { tx: WalletTransaction; onDone: () => void }) {
  return (
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <BackButton onPress={onDone} />

      <Text style={s.title}>
        {tx.type === "DEPOSIT" ? "Receive" : tx.type === "WITHDRAW" ? "Send" : tx.type === "ACTIVATION" ? "Activation" : "Transaction"}
      </Text>

      {tx.amount != null && <Text className="my-2 font-serif text-[32px] text-foreground">{fmtAmount(tx)}</Text>}

      {tx.type === "ACTIVATION" && (
        <View style={s.card}>
          <Text className="font-sans text-[13px] leading-[19px] text-muted-foreground">
            Peridot paid the SOL to create your on-chain smart account (PDA). The activation
            cost — rent + network fee + margin — was reimbursed from your wallet to the
            Peridot treasury in the same transaction.
          </Text>
        </View>
      )}

      <Field label="Status" value={String(tx.status)} />
      <Field label="Type" value={tx.type ?? "—"} />
      <Field label="Amount" value={fmtAmount(tx)} />
      <Field label="Asset" value={tx.asset ?? "—"} />
      <Field label="Counterparty" value={shorten(tx.counterparty)} mono />
      <Field label="Network" value={`${tx.chain} · ${tx.network}`} />
      <Field label="Created" value={fmtDate(tx.createdAt)} />
      <Field label="Confirmed" value={fmtDate(tx.confirmedAt)} />

      {tx.txHash && (
        <UIButton
          title="View on Explorer"
          // Explorer cluster follows the selection (ANT-15 req 3): testnet
          // links carry ?cluster=devnet via the shared helper.
          onPress={() => {
            Linking.openURL(solanaExplorerTxUrl(tx.txHash, tx.network)).catch(() => undefined);
          }}
          variant="primary"
        />
      )}
    </ScrollView>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View className="gap-1">
      <Text style={s.label}>{label}</Text>
      <Text className={mono ? "font-mono text-[13px] text-foreground" : "font-sans text-sm text-foreground"} selectable>{value}</Text>
    </View>
  );
}

function shorten(v: string | null): string {
  if (!v) return "—";
  return v.length > 24 ? `${v.slice(0, 12)}…${v.slice(-8)}` : v;
}
