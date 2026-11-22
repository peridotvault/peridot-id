import { useEffect, useState } from "react";
import type { PeridotClient } from "@peridotvault/pid-sdk-js";

export interface CatalogProvider {
  code: string;
  name: string;
  imageUrl: string | null;
  category: "web2" | "web3";
  protocol: string;
  isAvailable: boolean;
  isSupported: boolean;
}

/**
 * Platform provider catalogue (GET /v1/providers). Returns null until loaded or
 * when the fetch fails — callers then keep their existing allow-list behaviour
 * and the API still rejects unavailable providers.
 */
export function useProviderCatalog(peridot: PeridotClient): CatalogProvider[] | null {
  const [catalog, setCatalog] = useState<CatalogProvider[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await peridot.get<CatalogProvider[]>("/v1/providers");
        if (!cancelled && res.ok && Array.isArray(res.data)) setCatalog(res.data);
      } catch {
        // fail-open to the app's own switches; the server enforces availability
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [peridot]);

  return catalog;
}
