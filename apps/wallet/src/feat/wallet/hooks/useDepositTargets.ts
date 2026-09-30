import { useCallback, useEffect, useState } from "react";
import type { ChainAccount } from "@peridotvault/pid-types";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";
import { buildDepositTargets, type DepositTarget } from "../utils/deposit-targets";

export function useDepositTargets(peridot: PeridotClient) {
  const [targets, setTargets] = useState<DepositTarget[]>([]);

  const load = useCallback(async () => {
    let acc = await peridot.wallet.me();
    if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
    if ("statusCode" in acc) return;
    setTargets(buildDepositTargets(acc as ChainAccount[]));
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  return { targets, reload: load };
}
