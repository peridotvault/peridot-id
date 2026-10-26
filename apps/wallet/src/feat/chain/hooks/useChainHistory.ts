import { useCallback, useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import type { WalletTransaction } from "@peridotvault/pid-types";
import { clearApiCache } from "../../../shared/data/apiCache";
import { endNetworkTransition, subscribeNetworkMode } from "../../../shared/data/networkMode";
import {
  filterChainRowsForSelection,
  getSelection,
  isSolanaSelected,
  subscribeSelectedChains,
} from "../../../shared/data/selectedChains";

// Chain half of the activity feed. Tab-agnostic — the screen merges this with
// the fiat half. Re-fetches on network switch like useHomeData.
// ANT-625 strict selection: with a custom selection that excludes Solana the
// RPC history is skipped entirely (no unselected request fires); returned
// rows are filtered to the selected set (AC3) so a re-enabled chain never
// leaks rows from a still-unselected one.
export function useChainHistory(peridot: PeridotClient) {
  const [items, setItems] = useState<WalletTransaction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const sel = getSelection();
      if (!isSolanaSelected(sel)) {
        setItems([]);
        return;
      }
      const chain = await peridot.wallet.history();
      setItems(filterChainRowsForSelection((Array.isArray(chain) ? chain : []) as WalletTransaction[], sel));
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

  // Re-fetch chain history on network switch, then release the signing
  // block. A selection switch does the same via the selection store.
  useEffect(() => {
    return subscribeNetworkMode(() => {
      clearApiCache();
      load().then(endNetworkTransition, endNetworkTransition);
    });
  }, [load]);

  useEffect(() => {
    return subscribeSelectedChains(() => {
      clearApiCache();
      load().then(endNetworkTransition, endNetworkTransition);
    });
  }, [load]);

  return { items, busy, error, reload: load };
}
