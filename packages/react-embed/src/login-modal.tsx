"use client";

// Embedded wallet-login modal (stage 4 of docs/plan/04-embedded-login-sdk.md).
//
// The dapp hosts the UI; the WALLET hosted by the extension shows the approval.
// No PeridotID window opens for the external-wallet path: challenge, signature
// and verification all happen against the API from this page, and the wallet's
// private key never leaves the extension. An unknown address continues into the
// ordinary PID claim step, and a third-party app receives a one-time `pidCode`
// to exchange exactly like the hosted flow.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Peridot, type LinkedWallet, type PeridotEnv } from "@peridotvault/pid-sdk-js";
import { detectWallets, type WalletConnector } from "./wallet-connectors.js";

export interface PeridotLoginModalProps {
  open: boolean;
  /** Registered app id (`pidapp_…`) — binds the issued code to your app. */
  clientId?: string;
  env?: PeridotEnv;
  baseUrl?: string;
  popupBaseUrl?: string;
  /** Cross-origin target for the `pid_code`. Default: the current origin. */
  returnTo?: string;
  /** PKCE S256 challenge; required when the app is a public client. */
  codeChallenge?: string;
  /**
   * `link` attaches the wallet to the CURRENT session's PID instead of signing
   * in. It needs the session cookie/bearer the dapp already holds, so the modal
   * never asks for a password or a second identity.
   */
  mode?: "login" | "link";
  /** Signed in. `pidCode` is present when `returnTo`/`clientId` were bound. */
  onSuccess(result: { pid: string; pidCode?: string }): void;
  /** A wallet was attached to this PID (`mode: "link"`). */
  onLinked?(wallet: LinkedWallet): void;
  onClose(): void;
  onError?(error: Error): void;
}

type Phase = "idle" | "busy" | "claim" | "done";

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2147483000,
};
const panel: CSSProperties = {
  width: "min(380px, 92vw)",
  background: "#0b0f0c",
  color: "#e9f5ee",
  border: "1px solid #1e2b23",
  borderRadius: 16,
  padding: 24,
  fontFamily: "inherit",
  display: "grid",
  gap: 12,
};
const button: CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #2c4636",
  background: "#12251a",
  color: "inherit",
  cursor: "pointer",
  fontSize: 15,
  textAlign: "left",
};
const input: CSSProperties = { ...button, cursor: "text", background: "#0f1a13" };
const muted: CSSProperties = { opacity: 0.7, fontSize: 13, margin: 0 };
const alert: CSSProperties = { color: "#ffb4b4", fontSize: 13, margin: 0 };

function isCancellation(message: string): boolean {
  return /reject|denied|cancel|closed/i.test(message);
}

/**
 * Modal login with an external wallet (Phantom/Solana, MetaMask/EVM).
 * Renders nothing until `open`. Accessible: labelled dialog, focus moved in on
 * open and restored on close, Escape to dismiss, errors announced.
 */
export function PeridotLoginModal(props: PeridotLoginModalProps) {
  const { open, clientId, env, baseUrl, popupBaseUrl, returnTo, codeChallenge, mode = "login", onSuccess, onLinked, onClose, onError } = props;
  const peridot = useMemo(() => Peridot({ clientId, env, baseUrl, popupBaseUrl }), [clientId, env, baseUrl, popupBaseUrl]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [claimTicket, setClaimTicket] = useState<string | undefined>(undefined);
  const [handle, setHandle] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const wallets = useMemo(() => (open ? detectWallets() : []), [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
    panelRef.current?.querySelector<HTMLElement>("button, input")?.focus();
    return () => previouslyFocused.current?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const finish = useCallback(
    (pid: string, pidCode?: string) => {
      setPhase("done");
      setStatus("");
      onSuccess({ pid, ...(pidCode ? { pidCode } : {}) });
    },
    [onSuccess],
  );

  const signIn = useCallback(
    async (wallet: WalletConnector) => {
      setError(null);
      setPhase("busy");
      setStatus(`Connecting to ${wallet.label}…`);
      try {
        const address = await wallet.connect();
        setStatus("Approve the signature in your wallet…");
        if (mode === "link") {
          const challenge = await peridot.auth.walletLinkChallenge({
            namespace: wallet.namespace,
            reference: wallet.reference,
            address,
          });
          const signature = await wallet.signMessage(address, challenge.message);
          setStatus("Verifying…");
          const linked = await peridot.auth.walletLink(challenge.challengeId, signature);
          setPhase("done");
          setStatus(`${wallet.label} linked.`);
          onLinked?.(linked);
          return;
        }
        const challenge = await peridot.auth.walletChallenge({
          namespace: wallet.namespace,
          reference: wallet.reference,
          address,
          ...(clientId ? { clientId } : {}),
          ...(returnTo ? { returnTo } : {}),
          ...(codeChallenge ? { codeChallenge } : {}),
        });
        const signature = await wallet.signMessage(address, challenge.message);
        setStatus("Verifying…");
        const result = await peridot.auth.walletVerify(challenge.challengeId, signature);
        if (result.pendingClaim) {
          setClaimTicket(result.claimTicket);
          setPhase("claim");
          setStatus("");
          return;
        }
        finish(result.pid ?? "", result.pidCode);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setPhase("idle");
        if (isCancellation(message)) {
          setStatus(`${wallet.label} signature cancelled — try again.`);
          return;
        }
        setStatus("");
        setError(message);
        onError?.(err instanceof Error ? err : new Error(message));
      }
    },
    [peridot, mode, clientId, returnTo, codeChallenge, finish, onLinked, onError],
  );

  const claim = useCallback(async () => {
    setError(null);
    setPhase("busy");
    setStatus("Creating your PeridotID…");
    try {
      const res = await peridot.auth.claim(handle, claimTicket);
      finish(res.pid, res.pidCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPhase("claim");
      setStatus("");
      setError(message);
      onError?.(err instanceof Error ? err : new Error(message));
    }
  }, [peridot, handle, claimTicket, finish, onError]);

  if (!open) return null;

  const busy = phase === "busy";

  return (
    <div style={overlay} role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="pid-login-title" style={panel}>
        <h2 id="pid-login-title" style={{ margin: 0, fontSize: 18 }}>
          {mode === "link" ? "Link a wallet" : "Sign in with PeridotID"}
        </h2>

        {phase === "claim" ? (
          <form
            style={{ display: "grid", gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              void claim();
            }}
          >
            <p style={muted}>Your wallet is verified. Choose your permanent handle — it can never be changed.</p>
            <input
              style={input}
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase())}
              placeholder="your_handle"
              aria-label="PID handle"
              autoComplete="off"
              pattern="[a-z0-9_]{3,20}"
              required
            />
            <button style={button} type="submit" disabled={busy}>
              {busy ? "Creating…" : "Claim @pid"}
            </button>
          </form>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {wallets.length === 0 ? (
              <p style={muted}>No browser wallet found. Install Phantom or MetaMask to sign in with a wallet.</p>
            ) : (
              wallets.map((wallet) => (
                <button key={wallet.kind} style={button} disabled={busy} onClick={() => void signIn(wallet)}>
                  {wallet.label}
                </button>
              ))
            )}
          </div>
        )}

        {status ? (
          <p style={muted} aria-live="polite">
            {status}
          </p>
        ) : null}
        {error ? (
          <p style={alert} role="alert">
            {error}
          </p>
        ) : null}

        <button
          style={{ ...button, textAlign: "center", border: "none", background: "transparent", opacity: 0.75 }}
          onClick={onClose}
        >
          {phase === "done" ? "Close" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
