"use client";

// Opener (parent) side of the embed bridge. Mounts the PeridotID wallet in an
// iframe and owns every trust-critical ceremony: sign-in opens the PeridotID
// popup, the exchanged read-only bearer is handed to the iframe over
// postMessage, and each write the iframe delegates runs through the same
// approval popup the dapp flow already uses. Nothing trust-critical runs in the
// host DOM. The hosted (iframe) side lives in @peridotvault/pid-sdk-js.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  EMBED_LOGIN,
  EMBED_READY,
  EMBED_TOKEN,
  Peridot,
  type ApiError,
  type ExchangeResult,
  type PeridotEnv,
} from "@peridotvault/pid-sdk-js";

export interface PeridotWalletEmbedProps {
  /** Registered app id (`pidapp_…`) — binds the issued login code to your app. */
  clientId?: string;
  /** Force the target environment. Default: NODE_ENV-derived (see the SDK). */
  env?: PeridotEnv;
  /** Advanced: API origin override (self-host/localhost). */
  baseUrl?: string;
  /** Wallet/popup host override. Preset from `env` unless `baseUrl` is passed. */
  popupBaseUrl?: string;
  /** Advanced: embed host, when it differs from the popup host. */
  walletUrl?: string;
  className?: string;
  style?: CSSProperties;
  /** The iframe is mounted and listening (fires on every reload). */
  onReady?: () => void;
  /** The user signed in; carries the exchanged identity (bearer stays internal). */
  onIdentity?: (identity: ExchangeResult) => void;
  onError?: (error: Error) => void;
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && "statusCode" in value;
}

/**
 * Drop-in wallet: render it into any div and the wallet handles its own
 * connect/write ceremonies. Sizing comes from the host (`style`/`className`).
 */
export function PeridotWalletEmbed(props: PeridotWalletEmbedProps) {
  const { clientId, env, baseUrl, popupBaseUrl, walletUrl, className, style } = props;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const peridot = useMemo(
    () => Peridot({ clientId, env, baseUrl, popupBaseUrl }),
    [clientId, env, baseUrl, popupBaseUrl],
  );
  const host = walletUrl ?? peridot.popupBaseUrl;
  const embedOrigin = useMemo(() => (host ? new URL(host).origin : null), [host]);

  // Latest props without re-subscribing the message listener.
  const propsRef = useRef(props);
  propsRef.current = props;
  const bearerRef = useRef<string | undefined>(undefined);
  const [src, setSrc] = useState<string | null>(null);

  const post = useCallback(
    (msg: unknown) => {
      if (!embedOrigin) return;
      iframeRef.current?.contentWindow?.postMessage(msg, embedOrigin);
    },
    [embedOrigin],
  );

  const connect = useCallback(async () => {
    try {
      const { pidCode } = await peridot.auth.loginPopup({ clientId });
      if (!pidCode) throw new Error("Sign-in was cancelled.");
      const result = await peridot.auth.exchange(pidCode, clientId);
      if (isApiError(result)) throw new Error("Sign-in exchange failed.");
      bearerRef.current = result.accessToken;
      post({ type: EMBED_TOKEN, token: result.accessToken });
      propsRef.current.onIdentity?.(result);
    } catch (e) {
      propsRef.current.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }, [peridot, clientId, post]);

  useEffect(() => {
    if (!embedOrigin || !host || typeof window === "undefined") return;
    const url = new URL(host);
    url.searchParams.set("embed", "1");
    url.searchParams.set("origin", window.location.origin);
    setSrc(url.toString());
  }, [embedOrigin, host]);

  useEffect(() => {
    if (!embedOrigin) return;
    const onMessage = async (e: MessageEvent): Promise<void> => {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow || e.origin !== embedOrigin) return;
      const msg = e.data as { type?: unknown };
      if (msg?.type === EMBED_READY) {
        propsRef.current.onReady?.();
        if (bearerRef.current) post({ type: EMBED_TOKEN, token: bearerRef.current });
      } else if (msg?.type === EMBED_LOGIN) {
        await connect();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [embedOrigin, connect, post]);

  if (!embedOrigin) {
    throw new Error(
      "PeridotWalletEmbed: no wallet host. Pass popupBaseUrl or walletUrl, or omit baseUrl so the env preset applies.",
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={src ?? undefined}
      title="PeridotID wallet"
      className={className}
      style={style ?? { width: "100%", height: "100%", border: "0" }}
      allow="clipboard-write"
    />
  );
}
