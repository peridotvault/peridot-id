import { useEffect, useSyncExternalStore } from "react";
import {
  getNetworkMode,
  isNetworkSwitching,
  isSolanaAvailable,
  networkLabel,
  refreshSolanaAvailability,
  subscribeNetworkMode,
} from "../data/networkMode";

// Reactive view over the networkMode store. Screens and feat hooks
// subscribe here; shared/ never imports pages/ or feat/ (AGENTS.md).
// solanaAvailable is the data-driven ANT-78 gate: testnet → true (no fetch),
// mainnet → cached GET /v1/chains/solana-availability (fail closed, refresh
// on mount/mode change, 30s TTL + in-flight dedup in the store).
export function useNetworkMode(): {
  mode: "mainnet" | "testnet";
  testnet: boolean;
  switching: boolean;
  label: string;
  solanaAvailable: boolean;
} {
  const mode = useSyncExternalStore(subscribeNetworkMode, getNetworkMode, getNetworkMode);
  const switching = useSyncExternalStore(
    subscribeNetworkMode,
    isNetworkSwitching,
    isNetworkSwitching,
  );
  const solanaAvailable = useSyncExternalStore(
    subscribeNetworkMode,
    isSolanaAvailable,
    isSolanaAvailable,
  );
  useEffect(() => {
    if (mode === "mainnet") void refreshSolanaAvailability();
  }, [mode]);
  return { mode, testnet: mode === "testnet", switching, label: networkLabel(mode), solanaAvailable };
}
