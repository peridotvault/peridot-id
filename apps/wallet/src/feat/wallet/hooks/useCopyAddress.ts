import { useCallback, useState } from "react";

// Keyed clipboard with a 2s "copied" flag per key. Covers both the
// multi-address list (ReceiveScreen, keyed by target) and single-address
// cases (ActivationScreen, keyed "address").
export function useCopyAddress() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copy = useCallback(async (key: string, address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // clipboard unavailable — nothing to do
    }
  }, []);

  const isCopied = useCallback((key: string) => copiedKey === key, [copiedKey]);

  return { copiedKey, copy, isCopied };
}
