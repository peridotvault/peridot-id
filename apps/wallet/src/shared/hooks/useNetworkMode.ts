import { useSyncExternalStore } from "react";
import {
  getNetworkMode,
  isNetworkSwitching,
  networkLabel,
  subscribeNetworkMode,
} from "../network-mode";

// Reactive view over the network-mode store. Screens and feat hooks
// subscribe here; shared/ never imports screens/ or feat/ (AGENTS.md).
export function useNetworkMode(): {
  mode: "mainnet" | "testnet";
  testnet: boolean;
  switching: boolean;
  label: string;
} {
  const mode = useSyncExternalStore(subscribeNetworkMode, getNetworkMode, getNetworkMode);
  const switching = useSyncExternalStore(
    subscribeNetworkMode,
    isNetworkSwitching,
    isNetworkSwitching,
  );
  return { mode, testnet: mode === "testnet", switching, label: networkLabel(mode) };
}
