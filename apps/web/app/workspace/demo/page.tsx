"use client";

// Third-party sample: this page behaves EXACTLY like an external dapp —
// no session cookie, no signer, popupBaseUrl only. Every trust-critical
// action opens the PeridotID wallet popup for user approval; reads that
// need a session are unavailable here by design (delegated tokens planned).
// Runs against local API via loopback (no client_id needed) or prod with
// NEXT_PUBLIC_PID_CLIENT_ID set.

import { useMemo, useState } from "react";
import { Peridot, openLoginPopup, type CheckoutDepositView, type FiatLedgerEntry } from "@peridotvault/pid-sdk-js";
import { Card, ERROR, MUTED } from "../_components/ui";
import { PageHeader } from "../_components/page-header";
import { CutButton } from "@/components/landing/cut-button";

const API_BASE = process.env.NEXT_PUBLIC_PID_API_URL ?? "https://api.pid.peridotvault.com";
// Wallet host that renders the approval popup (local Expo web or prod app).
const POPUP_URL = process.env.NEXT_PUBLIC_PID_POPUP_URL ?? "http://localhost:8081";
const CLIENT_ID = process.env.NEXT_PUBLIC_PID_CLIENT_ID; // optional; loopback needs none

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function DemoPage() {
  const peridot = useMemo(
    () =>
      Peridot({
        baseUrl: API_BASE,
        solanaRpcUrl: "https://api.devnet.solana.com",
        popupBaseUrl: POPUP_URL, // no passkeySigner → third-party popup mode
      }),
    [],
  );
  const [pid, setPid] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [net, setNet] = useState("100000");
  const [toPid, setToPid] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [deposit, setDeposit] = useState<CheckoutDepositView | null>(null);
  const [receipt, setReceipt] = useState<FiatLedgerEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    run("connect", async () => {
      const { pidCode } = await openLoginPopup({
        popupBaseUrl: POPUP_URL,
        params: {
          popup: "login",
          origin: window.location.origin,
          ...(CLIENT_ID ? { client_id: CLIENT_ID } : {}),
        },
      });
      if (!pidCode) throw new Error("Sign-in was rejected.");
      const me = await peridot.auth.exchange(pidCode, CLIENT_ID);
      if ("statusCode" in me) throw new Error("Exchange failed.");
      setPid(me.pid);
      setName(me.profile?.displayName ?? null);
    });

  const topup = () =>
    run("topup", async () => {
      // Popup approval: user reviews the server quote, approves, and the
      // popup navigates itself to the DOKU payment page.
      const view = await peridot.fiat.checkoutDeposit(net.replace(/\D/g, ""));
      setDeposit(view);
      setReceipt(null);
    });

  const transfer = () =>
    run("transfer", async () => {
      // One popup ceremony: inquiry + verified recipient + confirm on Approve.
      const tx = await peridot.fiat.transferViaPopup({
        amountIdr: sendAmount.replace(/\D/g, ""),
        beneficiaryPid: toPid.trim(),
      });
      setReceipt(tx);
      setDeposit(null);
    });

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-16 sm:px-8">
      <PageHeader eyebrow="Sample dapp" title="Third-party demo" />
      <p className={`mt-2 text-sm ${MUTED}`}>
        Behaves like an external app: no session, no signer — approvals open the PeridotID popup.
      </p>

      <Card className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">1 · Connect</h2>
        {pid ? (
          <p className="mt-1 text-sm">
            Signed in as <code>{pid}</code>
            {name ? ` (${name})` : ""}
          </p>
        ) : (
          <div className="mt-4">
            <CutButton type="button" onClick={connect} disabled={busy !== null}>
              {busy === "connect" ? "Waiting for popup…" : "Sign in with PeridotID"}
            </CutButton>
          </div>
        )}
      </Card>

      <Card className="mt-4">
        <h2 className="text-lg font-semibold tracking-tight">2 · Top up (popup approval)</h2>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            className="rounded border px-3 py-2 text-sm"
            value={net}
            onChange={(e) => setNet(e.target.value)}
            inputMode="numeric"
            placeholder="Net IDR, min 100000"
            aria-label="Net amount in IDR"
          />
          <CutButton type="button" onClick={topup} disabled={busy !== null || !pid}>
            {busy === "topup" ? "Waiting for approval…" : "Top up"}
          </CutButton>
        </div>
        {deposit && (
          <p className="mt-3 text-sm">
            Intent <code>{deposit.providerRef}</code> — pay {deposit.grossIdr} to receive {deposit.netIdr}.{" "}
            <a className="underline" href={deposit.paymentUrl} target="_blank" rel="noreferrer">
              Reopen payment page
            </a>
          </p>
        )}
      </Card>

      <Card className="mt-4">
        <h2 className="text-lg font-semibold tracking-tight">3 · Transfer (popup approval)</h2>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            className="rounded border px-3 py-2 text-sm"
            value={toPid}
            onChange={(e) => setToPid(e.target.value)}
            placeholder="Recipient, e.g. rani@pid"
            aria-label="Recipient PID"
          />
          <input
            className="rounded border px-3 py-2 text-sm"
            value={sendAmount}
            onChange={(e) => setSendAmount(e.target.value)}
            inputMode="numeric"
            placeholder="Gross points"
            aria-label="Amount in points"
          />
          <CutButton type="button" onClick={transfer} disabled={busy !== null || !pid}>
            {busy === "transfer" ? "Waiting for approval…" : "Send"}
          </CutButton>
        </div>
        {receipt && (
          <p className="mt-3 text-sm">
            Transfer <code>{receipt.entryGroup}</code> — {receipt.status}. Amount {receipt.amountIdr} (
            {receipt.direction}).
          </p>
        )}
      </Card>

      {error && (
        <p className={`mt-4 text-sm ${ERROR}`} role="alert">
          {error}
        </p>
      )}
      <p className={`mt-4 text-sm ${MUTED}`}>
        Balance reads need a first-party session and stay out of this demo by design; receipts returned by
        approvals are the source of truth here.
      </p>
    </main>
  );
}
