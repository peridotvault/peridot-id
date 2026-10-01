import { useCallback, useEffect, useRef, useState } from "react";
import { EmbedBridge, type EmbedParams } from "@peridotvault/pid-sdk-js";

/**
 * Hosted (iframe) side: wire the embed bridge, announce readiness, and expose
 * the read-only bearer the parent hands over. `requestLogin` asks the parent to
 * run the login popup (cookies never cross into the frame).
 */
export function useEmbedBridge(params: EmbedParams | null) {
  const [bearer, setBearer] = useState<string | null>(null);
  const bridgeRef = useRef<EmbedBridge | null>(null);

  useEffect(() => {
    if (!params) return;
    const bridge = new EmbedBridge(params.origin);
    bridgeRef.current = bridge;
    const off = bridge.onToken(setBearer);
    bridge.ready();
    return () => {
      off();
      bridge.destroy();
      bridgeRef.current = null;
    };
  }, [params]);

  const requestLogin = useCallback(() => {
    bridgeRef.current?.requestLogin();
  }, []);

  return { bearer, requestLogin };
}
