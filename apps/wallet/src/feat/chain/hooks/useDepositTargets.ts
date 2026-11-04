import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ApiError, ChainAccount } from "@peridotvault/pid-types";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { buildDepositTargets } from "../utils/depositTargets";
import { ensureChainRows } from "../utils/chainRows";
import { API_BASE_URL } from "../../../shared/app/config";
import {
  endNetworkTransition,
  getNetworkMode,
  isSolanaAvailable,
  refreshSolanaAvailability,
  subscribeNetworkMode,
} from "../../../shared/data/networkMode";
import {
  filterChainAccountsForSelection,
  getCachedChains,
  getChainsVersion,
  getSelection,
  refreshRegistryChains,
  subscribeSelectedChains,
} from "../../../shared/data/selectedChains";

// ANT-74 + ANT-78: Solana deposit targets render only when a Solana program
// exists for the current selection. Testnet always shows them; mainnet shows
// them only when GET /v1/chains/solana-availability reports available===true
// (fail closed). EVM rows always pass through. Refresh runs on mount/mode
// change (store dedupes in-flight + 30s TTL); the targets list re-filters
// when the cached flag resolves via the store subscription.
// ANT-625 strict selection: chain accounts are filtered to the selected set
// first (EVM deposit-target filtering only in v1 — no EVM RPC fan-out, OQ3).
// All-mode returns every row (byte-identical to today).
// Rows come from the ensure call (POST), not the read: a chain registered in
// the dashboard after this wallet was provisioned only gets its row then.
export function useDepositTargets(peridot: PeridotClient) {
  const [accounts, setAccounts] = useState<ChainAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mode = useSyncExternalStore(subscribeNetworkMode, getNetworkMode, getNetworkMode);
  const solanaAvailable = useSyncExternalStore(
    subscribeNetworkMode,
    isSolanaAvailable,
    isSolanaAvailable,
  );
  // Registry rows label the cards (name/symbol); re-render when they land.
  const chainsVersion = useSyncExternalStore(
    subscribeSelectedChains,
    getChainsVersion,
    getChainsVersion,
  );
  const selectionKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    selectionKey.current = JSON.stringify(getSelection());
    setLoading(true);
    setError(null);
    try {
      const acc = await ensureChainRows(peridot);
      if ("statusCode" in acc) {
        const e = acc as ApiError;
        setAccounts([]);
        setError(Array.isArray(e.message) ? e.message.join(" ") : e.message);
        return;
      }
      setAccounts(filterChainAccountsForSelection(acc as ChainAccount[], getSelection()));
    } catch (e) {
      setAccounts([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [peridot]);

  useEffect(() => {
    // Labels only — failure keeps the built-in fallback table.
    void refreshRegistryChains(API_BASE_URL).catch(() => undefined);
  }, []);

  useEffect(() => {
    // Retry on every screen load: fail-closed refresh re-runs when the
    // hook remounts; the store TTL + in-flight dedup prevent storms.
    if (mode === "mainnet") void refreshSolanaAvailability();
  }, [mode]);

  useEffect(() => {
    void load();
  }, [load, solanaAvailable]);

  // Re-filter on selection switch (same signing-block release as a network
  // switch — idempotent when no switch is in flight). Registry refreshes also
  // notify, so only a real selection change triggers another ensure call.
  useEffect(() => {
    return subscribeSelectedChains(() => {
      if (JSON.stringify(getSelection()) === selectionKey.current) {
        endNetworkTransition();
        return;
      }
      load().then(endNetworkTransition, endNetworkTransition);
    });
  }, [load]);

  const targets = useMemo(() => {
    const visible = solanaAvailable
      ? accounts
      : accounts.filter((a) => a.chainNamespace !== "solana");
    return buildDepositTargets(visible, getCachedChains() ?? []);
    // chainsVersion is a render trigger: getCachedChains() is not reactive.
  }, [accounts, solanaAvailable, chainsVersion]);

  return { targets, reload: load, loading, error };
}
