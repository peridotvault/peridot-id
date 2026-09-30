import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckoutDepositView, PeridotClient } from "@peridotvault/pid-sdk-js";

/**
 * Check a pending deposit against DOKU and unlock the Saldo when paid.
 * Webhooks cannot reach local dev (and may lag in prod), so the wallet
 * corroborates on demand — same server-side path as the webhook, never
 * trust-based. Safe to tap repeatedly; duplicate checks are no-ops.
 */
export function useCheckoutSync(peridot: PeridotClient) {
  const [pending, setPending] = useState<CheckoutDepositView | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const checkStatus = useCallback(async (intent: CheckoutDepositView) => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const tx = await peridot.fiat.syncTransaction(intent.id);
      if (tx.providerStatus === "settled" || tx.providerStatus === "success") {
        setSyncMsg("Payment confirmed — your Saldo is updated. You can go back.");
        setPending(null);
      } else if (["failed", "cancelled", "expired"].includes(tx.providerStatus)) {
        setSyncMsg("This payment did not go through — no money moved. You can try again.");
        setPending(null);
      } else {
        setSyncMsg("Still waiting for your bank transfer — check status again in a bit.");
      }
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }, [peridot]);

  // Auto-check once when returning from the payment page with a fresh intent:
  // the user just paid (or abandoned), so corroborate without making them dig.
  const autoSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pending || autoSyncedRef.current === pending.id) return;
    autoSyncedRef.current = pending.id;
    void checkStatus(pending);
  }, [pending, checkStatus]);

  return { pending, setPending, syncing, syncMsg, checkStatus };
}
