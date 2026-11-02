import { useState } from "react";
import { Section, SectionHead } from "../../shared/components/ui/Section";
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
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader onBack={onDone} title={titleOf(item, incoming)} />
        </SectionHead>
      </Section>

      <Section>
        <SectionHead className="pb-0">
          <span className="font-mono text-2xl text-foreground">{sign}{fmtIdr(amount)}</span>
        </SectionHead>

        <div className="flex flex-col divide-y divide-line border-t border-line">
          <Field label="Status" value={ledgerStatusLabel(tx.status)} />
          {tx.counterpartyPid && <Field label={incoming ? "From" : "To"} value={tx.counterpartyPid} />}
          <Field label={incoming ? "Credited" : "Debited"} value={fmtIdr(tx.amountIdr)} />
          <Field label="Reference" value={tx.entryGroup} />
          <Field label="Created" value={fmtDate(item.createdAt)} />
        </div>
      </Section>

      {error && (
        <Section className="border-t-danger/40 bg-danger/10">
          <SectionHead className="py-3">
            <p role="alert" className="font-sans text-sm text-foreground">{error}</p>
          </SectionHead>
        </Section>
      )}

      {cancellable && (
        <Section>
          <SectionHead className="pb-8">
            <UIButton title={busy ? "Cancelling…" : "Cancel transfer"} onPress={cancel} disabled={busy} variant="danger" />
          </SectionHead>
        </Section>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-6 py-3">
      <span className="font-sans text-xs uppercase tracking-[0.6px] text-muted-foreground">{label}</span>
      <span className="select-text text-right font-sans text-sm text-foreground">{value}</span>
    </div>
  );
}
