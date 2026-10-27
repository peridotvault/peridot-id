import { useCallback, useEffect, useState } from "react";
import type { Authority } from "@peridotvault/pid-types";
import type { ActivationView, PeridotClient } from "@peridotvault/pid-sdk-js";

const LAMPORTS_PER_SOL = 1e9;

// Status-only activation gate for the Receive funding view: activation +
// passkey fetch and SOL-denominated derived values.
//
// ANT-731 WS4: there is no separate user-facing setup step — the first send
// sets the account up automatically inside the send flow (see
// feat/chain/utils/firstAction.ts). This hook never triggers setup; it only
// reports funding status so the Receive modal can show the right hint.
export function useActivationGate(peridot: PeridotClient) {
  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const act = await peridot.wallet.activation();
      if (!("statusCode" in act)) setActivation(act as ActivationView);
    } catch {
      /* keep stale activation */
    }
    try {
      const creds = await peridot.passkey.list();
      setPasskeys(Array.isArray(creds) ? (creds as Authority[]) : []);
    } catch {
      setPasskeys([]);
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearError = useCallback(() => setError(null), []);

  const st = activation?.status;
  return {
    activation,
    passkeys,
    st,
    isActive: st === "active",
    ready: st === "ready",
    requiredSol: activation ? Number(activation.requiredLamports) / LAMPORTS_PER_SOL : 0,
    balanceSol: activation ? Number(activation.balanceLamports) / LAMPORTS_PER_SOL : 0,
    hasPasskey: passkeys.length > 0,
    busy,
    error,
    clearError,
    refresh,
  };
}
