import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChainAccount } from "@peridotvault/pid-types";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { buildDepositTargets, type DepositTarget } from "../utils/depositTargets";
import {
  endNetworkTransition,
  getNetworkMode,
  isSolanaAvailable,
  refreshSolanaAvailability,
  subscribeNetworkMode,
} from "../../../shared/data/networkMode";
import {
  filterChainAccountsForSelection,
  getSelection,
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
export function useDepositTargets(peridot: PeridotClient) {
  const [targets, setTargets] = useState<DepositTarget[]>([]);
  const mode = useSyncExternalStore(subscribeNetworkMode, getNetworkMode, getNetworkMode);
  const solanaAvailable = useSyncExternalStore(
    subscribeNetworkMode,
    isSolanaAvailable,
    isSolanaAvailable,
  );

  const load = useCallback(async () => {
    let acc = await peridot.wallet.me();
    if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
    if ("statusCode" in acc) return;
    const selected = filterChainAccountsForSelection(acc as ChainAccount[], getSelection());
    const all = buildDepositTargets(selected);
    setTargets(isSolanaAvailable() ? all : all.filter((t) => !t.key.startsWith("solana-")));
  }, [peridot]);

  useEffect(() => {
    // Retry on every screen load: fail-closed refresh re-runs when the
    // hook remounts; the store TTL + in-flight dedup prevent storms.
    if (mode === "mainnet") void refreshSolanaAvailability();
  }, [mode]);

  useEffect(() => {
    load();
  }, [load, solanaAvailable]);

  // Re-filter on selection switch (same signing-block release as a network
  // switch — idempotent when no switch is in flight).
  useEffect(() => {
    return subscribeSelectedChains(() => {
      load().then(endNetworkTransition, endNetworkTransition);
    });
  }, [load]);

  return { targets, reload: load };
}
