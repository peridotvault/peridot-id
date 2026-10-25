import { useCallback, useEffect, useState } from "react";
import type { FiatDepositView, FiatLedgerEntry, PeridotClient } from "@peridotvault/pid-sdk-js";
import { pendingDeposit } from "../utils/history";
import { cachedRead, clearApiCache } from "../../../shared/data/apiCache";
import { endNetworkTransition, subscribeNetworkMode } from "../../../shared/data/networkMode";

// Fiat half of the activity feed: DOKU intents + ledger rows. Tab-agnostic —
// the screen merges this with the chain half. Re-fetches on network switch.
export function useFiatHistory(peridot: PeridotClient) {
  const [deposits, setDeposits] = useState<FiatDepositView[]>([]);
  const [entries, setEntries] = useState<FiatLedgerEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Money reads coalesce for 10s (same window as Home): revisits and the
      // StrictMode double-mount share one fetch instead of paying full price.
      const [depositsView, ledgerView] = await Promise.all([
        cachedRead("fiat.deposits", { ttlMs: 10_000 }, () => peridot.fiat.deposits()).catch(
          () => [] as FiatDepositView[],
        ),
        cachedRead("fiat.ledger", { ttlMs: 10_000 }, () => peridot.fiat.ledger().then((l) => l.rows)).catch(
          () => [] as FiatLedgerEntry[],
        ),
      ]);
      // Heal unsettled deposit intents against DOKU (local rows never self-heal).
      // Bounded fan-out: this is one request per pending deposit, so an account
      // with many open intents would blow the per-IP budget in a single load.
      // The rest heal on the next load.
      const healed = await Promise.all(
        depositsView
          .filter((x) => pendingDeposit(x))
          .slice(0, 3)
          .map((x) => peridot.fiat.syncTransaction(x.id).catch(() => null)),
      );
      const fresh = new Map(healed.filter((x) => x !== null).map((x) => [x.id, x]));
      setDeposits(depositsView.map((x) => fresh.get(x.id) ?? x));
      setEntries(ledgerView);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    return subscribeNetworkMode(() => {
      clearApiCache();
      load().then(endNetworkTransition, endNetworkTransition);
    });
  }, [load]);

  return { deposits, entries, busy, error, reload: load };
}
