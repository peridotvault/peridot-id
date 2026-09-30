import { useCallback, useEffect, useState } from "react";
import type { FiatDepositView, FiatLedgerEntry, PeridotClient } from "@peridotvault/pid-sdk-js";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { pendingDeposit } from "../utils/feed";

// Unified feed source: chain history + DOKU intents + fiat ledger rows.
// Tab-agnostic — the screen filters via selectVisible.
export function useActivityFeed(peridot: PeridotClient) {
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [deposits, setDeposits] = useState<FiatDepositView[]>([]);
  const [entries, setEntries] = useState<FiatLedgerEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [chain, depositsView, ledgerView] = await Promise.all([
        peridot.wallet.history(),
        peridot.fiat.deposits().catch(() => [] as FiatDepositView[]),
        peridot.fiat.ledger().then((l) => l.rows).catch(() => [] as FiatLedgerEntry[]),
      ]);
      // Heal unsettled deposit intents against DOKU (local rows never self-heal).
      const healed = await Promise.all(
        depositsView
          .filter((x) => pendingDeposit(x))
          .map((x) => peridot.fiat.syncTransaction(x.id).catch(() => null)),
      );
      const fresh = new Map(healed.filter((x) => x !== null).map((x) => [x.id, x]));
      setItems((Array.isArray(chain) ? chain : []) as WalletTransaction[]);
      setDeposits(depositsView.map((x) => fresh.get(x.id) ?? x));
      setEntries(ledgerView);
    } catch (e) {
      setError(String(e));
      // Non-fatal: keep showing cached local history if the RPC is unreachable.
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  return { items, deposits, entries, busy, error, reload: load };
}
