import { useState } from "react";
import { ScrollArea } from "../shared/components/ScrollArea";
import { openExternalUrl } from "../shared/openExternal";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { PushHeader } from "../shared/components/PushHeader";
import { UIButton } from "../shared/components/UIButton";
import type { FiatItem } from "../shared/fiat";
import { fiatStatusLabel } from "../shared/fiat";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** A DOKU Checkout deposit intent (money-in). Once paid it disappears from
 *  here and appears on the fiat ledger as a fiat_issue entry. */
export function FiatDetailScreen({ item: initial, onDone }: { item: FiatItem; onDone: () => void }) {
  const { peridot } = usePeridot();
  const [item, setItem] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tx } = item;
  const awaitingPayment = tx.providerStatus === "created";

  const sync = async () => {
    setChecking(true);
    setError(null);
    try {
      const fresh = await peridot.fiat.syncTransaction(tx.id);
      setItem({ kind: "deposit", createdAt: fresh.createdAt, tx: fresh });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <PushHeader onBack={onDone} title="Deposit" />
      <span className="my-2 font-serif text-3xl text-foreground">{fmtIdr(tx.netIdr ?? tx.grossIdr)}</span>

      {awaitingPayment && (
        <div style={s.card} className="flex flex-col">
          <span className="font-sans text-sm leading-[19px] text-muted-foreground">Waiting for payment — complete it, then come back and check status.</span>
          {tx.paymentUrl && (
            <UIButton
              title="Open DOKU payment page"
              onPress={() => openExternalUrl(tx.paymentUrl as string).catch(() => setError("Could not open the DOKU payment page."))}
              variant="primary"
            />
          )}
        </div>
      )}

      <Field label="Status" value={fiatStatusLabel(item.kind, tx.providerStatus)} />
      {tx.feeIdr && <Field label="Service fee" value={fmtIdr(tx.feeIdr)} />}
      <Field label="Created" value={fmtDate(item.createdAt)} />

      {error && <p role="alert" style={s.error}>{error}</p>}

      {(awaitingPayment || tx.providerStatus === "processing") && (
        <UIButton title={checking ? "Checking…" : "Check status"} onPress={sync} disabled={checking} />
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
