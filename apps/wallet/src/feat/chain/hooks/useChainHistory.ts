import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { clearApiCache } from "../../../shared/data/api-cache";
import { endNetworkTransition, subscribeNetworkMode } from "../../../shared/data/network-mode";

// Chain half of the activity feed. Tab-agnostic — the screen merges this with
// the fiat half. Re-fetches on network switch like useHomeData.
export function useChainHistory(peridot: PeridotClient) {
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const chain = await peridot.wallet.history();
      setItems((Array.isArray(chain) ? chain : []) as WalletTransaction[]);
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

  // Re-fetch chain history on network switch, then release the signing block.
  useEffect(() => {
    return subscribeNetworkMode(() => {
      clearApiCache();
      load().then(endNetworkTransition, endNetworkTransition);
    });
  }, [load]);

  return { items, busy, error, reload: load };
}
