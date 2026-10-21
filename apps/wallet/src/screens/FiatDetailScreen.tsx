import { useState } from "react";
import { Linking, ScrollView, Text, View } from "../shared/primitives";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";
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
    <ScrollView className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 12 }}>
      <BackButton onPress={onDone} />

      <Text style={s.title}>Deposit</Text>
      <Text className="my-2 font-serif text-[32px] text-foreground">{fmtIdr(tx.netIdr ?? tx.grossIdr)}</Text>

      {awaitingPayment && (
        <View style={s.card}>
          <Text className="font-sans text-[13px] leading-[19px] text-muted-foreground">Waiting for payment — complete it, then come back and check status.</Text>
          {tx.paymentUrl && (
            <UIButton
              title="Open DOKU payment page"
              onPress={() => Linking.openURL(tx.paymentUrl as string).catch(() => setError("Could not open the DOKU payment page."))}
              variant="primary"
            />
          )}
        </View>
      )}

      <Field label="Status" value={fiatStatusLabel(item.kind, tx.providerStatus)} />
      {tx.feeIdr && <Field label="Service fee" value={fmtIdr(tx.feeIdr)} />}
      <Field label="Created" value={fmtDate(item.createdAt)} />

      {error && <Text role="alert" style={s.error}>{error}</Text>}

      {(awaitingPayment || tx.providerStatus === "processing") && (
        <UIButton title={checking ? "Checking…" : "Check status"} onPress={sync} disabled={checking} />
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
