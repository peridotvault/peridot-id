import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Chain } from "@peridotvault/pid-types";
import { API_BASE_URL } from "../app/config";
import { beginNetworkTransition } from "../data/networkMode";
import {
  applyChainToggle,
  dismissSelectionNotice,
  getCachedChains,
  getChainsVersion,
  getSelection,
  getSelectionNotice,
  refreshRegistryChains,
  selectionLabel,
  setSelectionAll,
  setSelectionCustom,
  subscribeSelectedChains,
  type SelectedChains,
} from "../data/selectedChains";

// Reactive view over the selectedChains store. Screens and feat hooks
// subscribe here; shared/ never imports pages/ or feat/ (AGENTS.md).
// Registry rows come from GET /v1/chains (30s TTL + in-flight dedup in the
// store); failures surface as chainsError with a retry (AC9 fail-closed —
// the last-known selection keeps rendering cached data, never a silent
// All-switch). Sanitizing against fresh rows drops unknown refs (AC8).
// Mutating calls open the network transition window (signing stays blocked
// under the same failsafe as a network switch); data hooks reload on the
// store subscription and close the window via endNetworkTransition().
export function useSelectedChains(): {
  selection: SelectedChains;
  chains: Chain[];
  chainsError: string | null;
  label: string;
  notice: string | null;
  setAll: () => void;
  setCustom: (chains: { namespace: string; reference: string }[]) => void;
  toggle: (namespace: string, reference: string) => void;
  retryChains: () => void;
  dismissNotice: () => void;
} {
  const selection = useSyncExternalStore(subscribeSelectedChains, getSelection, getSelection);
  const notice = useSyncExternalStore(subscribeSelectedChains, getSelectionNotice, getSelectionNotice);
  // Re-render when the registry list itself resolves (independent of the
  // selection/notice snapshots above).
  useSyncExternalStore(subscribeSelectedChains, getChainsVersion, getChainsVersion);
  const [chainsError, setChainsError] = useState<string | null>(null);
  const chains = getCachedChains() ?? [];
  const label = selectionLabel(selection);

  const load = useCallback(async (): Promise<void> => {
    try {
      await refreshRegistryChains(API_BASE_URL);
      setChainsError(null);
    } catch (e) {
      setChainsError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  useEffect(() => {
    load().catch(() => {
      // chainsError state carries the failure — the last-known selection
      // keeps rendering (AC9); the next mount retries.
    });
  }, [load]);

  const retryChains = useCallback(() => {
    load().catch(() => undefined);
  }, [load]);

  const setAll = useCallback(() => {
    if (setSelectionAll()) beginNetworkTransition();
  }, []);

  const setCustom = useCallback((chains: { namespace: string; reference: string }[]) => {
    if (setSelectionCustom(chains)) beginNetworkTransition();
  }, []);

  const toggle = useCallback((namespace: string, reference: string) => {
    if (applyChainToggle(namespace, reference, API_BASE_URL)) beginNetworkTransition();
  }, []);

  return {
    selection,
    chains,
    chainsError,
    label,
    notice,
    setAll,
    setCustom,
    toggle,
    retryChains,
    dismissNotice: dismissSelectionNotice,
  };
}
