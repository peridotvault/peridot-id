import { useState } from "react";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { openExternalUrl } from "../../shared/app/openExternal";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";
import type { FiatItem } from "../../shared/data/fiat";
import { fiatStatusLabel } from "../../shared/data/fiat";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** A DOKU Checkout deposit intent (money-in). Once paid it disappears from
 *  here and appears on the fiat ledger as a fiat_issue entry. */
export function FiatDetail({ item: initial, onDone }: { item: FiatItem; onDone: () => void }) {
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
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader onBack={onDone} title="Deposit" />
        </SectionHead>
      </Section>

      <Section>
        <SectionHead className="pb-0">
        <span className="font-mono text-2xl text-foreground">{fmtIdr(tx.netIdr ?? tx.grossIdr)}</span>

        {awaitingPayment && (
          <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
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
        </SectionHead>

        <div className="flex flex-col divide-y divide-line border-t border-line">
          <Field label="Status" value={fiatStatusLabel(item.kind, tx.providerStatus)} />
          {tx.feeIdr && <Field label="Service fee" value={fmtIdr(tx.feeIdr)} />}
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

      {(awaitingPayment || tx.providerStatus === "processing") && (
        <Section>
          <SectionHead className="pb-8">
            <UIButton title={checking ? "Checking…" : "Check status"} onPress={sync} disabled={checking} />
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
