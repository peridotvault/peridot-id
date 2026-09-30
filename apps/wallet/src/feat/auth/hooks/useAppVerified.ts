import { useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";

// Verified-partner badge (server-sourced trust signal, fail-closed to hidden).
export function useAppVerified(peridot: PeridotClient, appClientId: string | undefined): boolean {
  const [appVerified, setAppVerified] = useState(false);

  useEffect(() => {
    if (!appClientId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await peridot.get<{ isVerified: boolean }>(
          `/v1/auth/app-info?clientId=${encodeURIComponent(appClientId)}`,
        );
        if (!cancelled && res.ok) setAppVerified((res.data as { isVerified: boolean }).isVerified === true);
      } catch {
        // fail-closed: no badge
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appClientId, peridot]);

  return appVerified;
}
