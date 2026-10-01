// Embed bridge: a third-party page mounts the PeridotID wallet in an <iframe>
// and talks to it over postMessage. Reads ride a delegated read-only bearer
// (SameSite cookies don't cross a third-party frame); the parent authenticates
// in the PeridotID popup and hands the exchanged bearer over. Trust-critical
// writes never run in the iframe's DOM — the wallet's own client has no inline
// signer, so it opens the PeridotID popup (visible address bar) on its origin.
// This module holds the hosted (iframe) side; the opener side lives in
// @peridotvault/pid-react-embed. No prod hosts here — the parent origin is
// caller-supplied and validated. Import-safe on native: `window` is only
// touched inside functions.

import { parsePopupOrigin } from "./popup.js";

export const EMBED_READY = "pid-embed-ready";
export const EMBED_LOGIN = "pid-embed-login";
export const EMBED_TOKEN = "pid-embed-token";

export interface EmbedParams {
  /** Opener (parent) origin the iframe posts to and trusts. */
  origin: string;
}

/** Hosted side: parse `?embed=1&origin=<http(s) origin>`. Null unless both hold. */
export function readEmbedParams(): EmbedParams | null {
  if (typeof window === "undefined") return null;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get("embed") !== "1") return null;
    const origin = parsePopupOrigin(q.get("origin"));
    return origin ? { origin } : null;
  } catch {
    return null;
  }
}

/**
 * Hosted (iframe) side of the embed bridge. Validates the parent by origin and
 * source on every message. Create once the iframe knows its parent origin.
 */
export class EmbedBridge {
  private readonly tokenListeners = new Set<(token: string) => void>();
  private readonly onMessage: (e: MessageEvent) => void;

  constructor(private readonly parentOrigin: string) {
    this.onMessage = (e: MessageEvent): void => {
      if (e.source !== window.parent || e.origin !== this.parentOrigin) return;
      const msg = e.data as { type?: unknown; token?: unknown };
      if (msg?.type === EMBED_TOKEN && typeof msg.token === "string") {
        for (const cb of this.tokenListeners) cb(msg.token);
      }
    };
    window.addEventListener("message", this.onMessage);
  }

  /** Announce the iframe is mounted and listening for a token. */
  ready(): void {
    this.post({ type: EMBED_READY });
  }

  /** Ask the parent to authenticate (it opens the login popup + exchanges). */
  requestLogin(): void {
    this.post({ type: EMBED_LOGIN });
  }

  /** Fires whenever the parent hands over a (new) read-only bearer. */
  onToken(cb: (token: string) => void): () => void {
    this.tokenListeners.add(cb);
    return () => {
      this.tokenListeners.delete(cb);
    };
  }

  destroy(): void {
    window.removeEventListener("message", this.onMessage);
    this.tokenListeners.clear();
  }

  private post(msg: unknown): void {
    window.parent.postMessage(msg, this.parentOrigin);
  }
}
