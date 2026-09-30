import { useCallback, useEffect, useState } from "react";
import type { Authority } from "@peridotvault/pid-types";
import type { ActivationView, PeridotClient } from "@peridotvault/pid-sdk-js";

const LAMPORTS_PER_SOL = 1e9;

// Single copy of the activation gate shared by ReceiveScreen (SOL modal)
// and ActivationScreen (explainer flow): activation + passkey fetch,
// fund-and-activate (with me/createAccount ensure), and SOL-denominated
// derived values.
export function useActivationGate(peridot: PeridotClient) {
  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
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
    }
  }, [peridot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearError = useCallback(() => setError(null), []);

  const activate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let acc = await peridot.wallet.me();
      if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
      if ("statusCode" in acc) throw new Error("Failed to create account");
      const res = await peridot.wallet.activate();
      if ("statusCode" in res) {
        const msg = Array.isArray(res.message) ? res.message.join(" ") : (res.message as string);
        throw new Error(msg);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [peridot, refresh]);

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
    activate,
  };
}
