import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { openExternalUrl } from "../../shared/app/openExternal";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { formatFeeAmount } from "@peridotvault/pid-sdk-js";
import { styles as s } from "../../shared/styles/theme";
import { solanaExplorerTxUrl } from "../../shared/data/networkMode";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";

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

// Receipt fee leg: integer-math formatting (dust-safe); a malformed recorded
// leg falls back to the raw base-unit string rather than crashing the receipt.
function fmtFee(baseUnits: string, fees: NonNullable<WalletTransaction["fees"]>): string {
  try {
    return formatFeeAmount(baseUnits, fees.decimals, fees.symbol);
  } catch {
    return `${baseUnits} base units`;
  }
}

export function ActivityDetail({ tx, onDone }: { tx: WalletTransaction; onDone: () => void }) {
  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <PushHeader
        onBack={onDone}
        title={tx.type === "DEPOSIT" ? "Receive" : tx.type === "WITHDRAW" ? "Send" : tx.type === "ACTIVATION" ? "Activation" : "Transaction"}
      />

      {tx.amount != null && <span className="my-2 font-serif text-3xl text-foreground">{fmtAmount(tx)}</span>}

      {tx.type === "ACTIVATION" && (
        <div style={s.card} className="flex flex-col">
          <span className="font-sans text-sm leading-[19px] text-muted-foreground">
            Peridot paid the SOL to create your on-chain smart account (PDA). The activation
            cost — rent + network fee + margin — was reimbursed from your wallet to the
            Peridot treasury in the same transaction.
          </span>
        </div>
      )}

      <Field label="Status" value={String(tx.status)} />
      <Field label="Type" value={tx.type ?? "—"} />
      <Field label="Amount" value={fmtAmount(tx)} />
      <Field label="Asset" value={tx.asset ?? "—"} />
      <Field label="Counterparty" value={shorten(tx.counterparty)} mono />
      <div className="flex flex-col gap-1">
        <span style={s.label}>Fees</span>
        {tx.fees != null ? (
          <span className="select-text font-mono text-sm text-foreground">
            Network {fmtFee(tx.fees.networkFee, tx.fees)} · Service {fmtFee(tx.fees.platformFee, tx.fees)} · Total {fmtFee(tx.fees.totalFee, tx.fees)}
          </span>
        ) : (
          <span className="font-sans text-sm text-muted-foreground">Fee breakdown not recorded for this transaction.</span>
        )}
      </div>
      <Field label="Network" value={`${tx.chain} · ${tx.network}`} />
      <Field label="Created" value={fmtDate(tx.createdAt)} />
      <Field label="Confirmed" value={fmtDate(tx.confirmedAt)} />

      {tx.txHash && (
        <UIButton
          title="View on Explorer"
          // Explorer cluster follows the selection (ANT-15 req 3): testnet
          // links carry ?cluster=devnet via the shared helper.
          onPress={() => {
            openExternalUrl(solanaExplorerTxUrl(tx.txHash, tx.network)).catch(() => undefined);
          }}
          variant="primary"
        />
      )}
    </ScrollArea>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span style={s.label}>{label}</span>
      <span className={mono ? "select-text font-mono text-sm text-foreground" : "select-text font-sans text-sm text-foreground"}>{value}</span>
    </div>
  );
}

function shorten(v: string | null): string {
  if (!v) return "—";
  return v.length > 24 ? `${v.slice(0, 12)}…${v.slice(-8)}` : v;
}
