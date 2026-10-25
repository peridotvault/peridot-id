import { useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";
import type { FiatLedgerItem } from "../../shared/data/fiat";
import { ledgerStatusLabel } from "../../shared/data/fiat";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

function titleOf(item: FiatLedgerItem, incoming: boolean): string {
  if (item.kind === "deposit") return "Deposit";
  if (item.kind === "adjust") return "Adjustment";
  return incoming ? "Transfer in" : "Transfer out";
}

/** Immutable fiat ledger entry. Read-only except a
 *  not-yet-posted outgoing transfer, which can be cancelled. */
export function FiatLedgerDetail({ item: initial, onDone }: { item: FiatLedgerItem; onDone: () => void }) {
  const { peridot } = usePeridot();
  const [item, setItem] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tx } = item;
  const incoming = tx.direction === "in";
  const posted = tx.status === "posted";
  const sign = posted ? (incoming ? "+" : "-") : "";
  const amount = tx.amountIdr;
  const cancellable = tx.status === "created" && tx.kind === "fiat_transfer_out";

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      const fresh = await peridot.fiat.cancelTransaction(tx.id);
      setItem({ ...item, tx: fresh });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={s.container}>
      <PushHeader onBack={onDone} title={titleOf(item, incoming)} />
      <span className="my-2 font-serif text-3xl text-foreground">{sign}{fmtIdr(amount)}</span>

      <Field label="Status" value={ledgerStatusLabel(tx.status)} />
      {tx.counterpartyPid && <Field label={incoming ? "From" : "To"} value={tx.counterpartyPid} />}
      <Field label={incoming ? "Credited" : "Debited"} value={fmtIdr(tx.amountIdr)} />
      <Field label="Reference" value={tx.entryGroup} />
      <Field label="Created" value={fmtDate(item.createdAt)} />

      {error && <p role="alert" style={s.error}>{error}</p>}

      {cancellable && (
        <UIButton title={busy ? "Cancelling…" : "Cancel transfer"} onPress={cancel} disabled={busy} variant="danger" />
      )}
    </ScrollArea>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span style={s.label}>{label}</span>
      <span className="select-text font-sans text-sm text-foreground">{value}</span>
    </div>
  );
}
