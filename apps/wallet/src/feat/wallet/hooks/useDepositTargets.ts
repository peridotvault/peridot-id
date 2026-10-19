import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ChainAccount } from "@peridotvault/pid-types";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { buildDepositTargets, type DepositTarget } from "../utils/deposit-targets";
import { getNetworkMode, isSolanaAvailable, subscribeNetworkMode } from "../../../shared/network-mode";

// ANT-74: Solana deposit targets render only when a Solana program exists
// for the current selection. v1 hard-code (see isSolanaAvailable): mainnet
// hides Solana rows, testnet shows them. EVM rows always pass through.
export function useDepositTargets(peridot: PeridotClient) {
  const [targets, setTargets] = useState<DepositTarget[]>([]);
  const mode = useSyncExternalStore(subscribeNetworkMode, getNetworkMode, getNetworkMode);

  const load = useCallback(async () => {
    let acc = await peridot.wallet.me();
    if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
    if ("statusCode" in acc) return;
    const all = buildDepositTargets(acc as ChainAccount[]);
    setTargets(isSolanaAvailable() ? all : all.filter((t) => !t.key.startsWith("solana-")));
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load, mode]);

  return { targets, reload: load };
}
