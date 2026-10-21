import { useState } from "react";
import { ScrollView, Text, View } from "../shared/primitives";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";
import { UIButton } from "../shared/components/UIButton";
import type { FiatLedgerItem } from "../shared/fiat";
import { ledgerStatusLabel } from "../shared/fiat";

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
export function FiatLedgerDetailScreen({ item: initial, onDone }: { item: FiatLedgerItem; onDone: () => void }) {
  const { peridot } = usePeridot();
  const [item, setItem] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { tx } = item;
  const incoming = tx.direction === "in";
  const posted = tx.status === "posted";
  const sign = posted ? (incoming ? "+" : "−") : "";
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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={s.container}>
      <BackButton onPress={onDone} />

      <Text style={s.title}>{titleOf(item, incoming)}</Text>
      <Text className="my-2 font-serif text-[32px] text-foreground">{sign}{fmtIdr(amount)}</Text>

      <Field label="Status" value={ledgerStatusLabel(tx.status)} />
      {tx.counterpartyPid && <Field label={incoming ? "From" : "To"} value={tx.counterpartyPid} />}
      <Field label={incoming ? "Credited" : "Debited"} value={fmtIdr(tx.amountIdr)} />
      <Field label="Reference" value={tx.entryGroup} />
      <Field label="Created" value={fmtDate(item.createdAt)} />

      {error && <Text role="alert" style={s.error}>{error}</Text>}

      {cancellable && (
        <UIButton title={busy ? "Cancelling…" : "Cancel transfer"} onPress={cancel} disabled={busy} variant="danger" />
      )}
    </ScrollView>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-1">
      <Text style={s.label}>{label}</Text>
      <Text className="font-sans text-sm text-foreground" selectable>{value}</Text>
    </View>
  );
}
