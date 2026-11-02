import { useCallback, useEffect, useState } from "react";
import { Section, SectionHead } from "../../shared/components/ui/Section";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { cachedRead } from "../../shared/data/apiCache";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";
import { formatTotalParts } from "../../shared/data/currency";
import { FiatAccountActions } from "../../feat/fiat/components/FiatAccountActions";

// Rupiah (DOKU ledger) account page: balance + Send/Receive/Top Up/Withdraw.
// Send/Top Up reuse the existing overlays; Receive/Withdraw unlock when the
// ledger API supports them.
export function FiatAccount({
  onDone,
  goSend,
  goTopup,
}: {
  onDone: () => void;
  goSend: () => void;
  goTopup: () => void;
}) {
  const { peridot } = usePeridot();
  const [balanceIdr, setBalanceIdr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await cachedRead("fiat.balance", { ttlMs: 10_000 }, () => peridot.fiat.balance());
      if ("statusCode" in v) throw new Error("Balance is temporarily unavailable.");
      setBalanceIdr(v.balanceIdr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setBalanceIdr(null);
      setError(
        /401|Unauthorized/i.test(msg)
          ? "Session expired — log in again."
          : /503|disabled|frozen|unavailable/i.test(msg)
            ? "Balance is temporarily unavailable."
            : msg,
      );
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const parts = balanceIdr === null ? null : formatTotalParts(Number(balanceIdr), "IDR");

  return (
    <div className="flex flex-col">
      <Section className="border-t-0">
        <SectionHead className="pb-0">
          <PushHeader onBack={onDone} title="Rupiah" />
        </SectionHead>
      </Section>

      {error ? (
        <Section className="border-t-danger/40 bg-danger/10">
          <SectionHead className="py-3">
            <p role="alert" className="font-sans text-sm text-foreground">{error}</p>
            <div className="mt-2"><UIButton title="Retry" onPress={load} /></div>
          </SectionHead>
        </Section>
      ) : (
        <Section>
          <SectionHead className="pb-5">
          {!parts ? (
            <span
              className="font-mono text-4xl text-foreground"
              role="status"
              aria-label="Loading Rupiah balance"
            >
              …
            </span>
          ) : (
            <div className="flex items-baseline" aria-label={`${parts.prefix}${parts.int}${parts.frac}`}>
              <span className="font-mono text-4xl text-foreground">{parts.prefix}{parts.int}</span>
              <span className="font-mono text-3xl text-muted-foreground">{parts.frac}</span>
            </div>
          )}
          </SectionHead>
        </Section>
      )}
      <FiatAccountActions onSend={goSend} onTopup={goTopup} />
    </div>
  );
}
