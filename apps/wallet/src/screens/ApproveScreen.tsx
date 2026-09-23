// Popup approval screen (web only). A third-party dapp opened this page via the
// SDK popup bridge (`?popup=<action>&origin=…`). The request arrives over the
// validated postMessage handshake — never trust the URL alone. On approve, the
// action runs here on the PeridotID origin with this session + passkey (the
// trusted DOM), and the result is posted back to the opener's origin.
import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  awaitPopupRequest,
  postPopupReady,
  postPopupResult,
  type CheckoutDepositView,
  type PeridotClient,
  type PopupParams,
  type SubTransferInquiryView,
} from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

const LAMPORTS_PER_SOL = 1e9;

type Phase = "waiting" | "preparing" | "review" | "busy" | "redirecting" | "done" | "failed";

function reqStr(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || !v) throw new Error(`Missing "${key}"`);
  return v;
}

function fmtAmount(amount: string, asset: string): string {
  if (asset !== "SOL") return `${amount} (raw units of ${asset})`;
  const sol = Number(BigInt(amount)) / LAMPORTS_PER_SOL;
  return `${sol} SOL`;
}

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

/** Human summary of the intent the user is about to sign. */
function summarize(action: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case "withdraw":
      return `Send ${fmtAmount(reqStr(p, "amount"), String(p.asset ?? "SOL"))} to ${reqStr(p, "to")}`;
    case "execute":
      return `Approve a smart-account action on program ${reqStr(p, "target")}`;
    case "topup":
      return `Deposit ${fmtAmount(reqStr(p, "amount"), String(p.asset ?? "SOL"))} into your smart account`;
    case "activate":
      return "Activate your smart account on-chain (one-time)";
    case "rotate":
      return "Replace this wallet's passkey authority with the registered replacement";
    case "register":
      return "Register a new passkey on this wallet";
    default:
      throw new Error(`Unknown action "${action}"`);
  }
}

async function runAction(peridot: PeridotClient, action: string, payload: unknown): Promise<unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case "withdraw":
      return peridot.wallet.withdraw({ amount: reqStr(p, "amount"), asset: String(p.asset ?? "SOL"), to: reqStr(p, "to") });
    case "execute":
      return peridot.wallet.execute({
        target: reqStr(p, "target"),
        metas: Array.isArray(p.metas) ? (p.metas as { address: string; writable: boolean; signer: boolean }[]) : [],
        data: reqStr(p, "data"),
      });
    case "topup":
      return peridot.wallet.topup({ amount: reqStr(p, "amount"), asset: String(p.asset ?? "SOL") });
    case "activate":
      return peridot.wallet.activate();
    case "rotate":
      return peridot.wallet.rotate({ oldCredentialId: typeof p.oldCredentialId === "string" ? p.oldCredentialId : undefined, newCredentialId: reqStr(p, "newCredentialId") });
    case "register":
      return peridot.passkey.register();
    default:
      throw new Error(`Unknown action "${action}"`);
  }
}

/** Fiat actions run through prepared server state (see prepareTransfer /
 *  prepareCheckout), not raw opener payload. Kept separate from runAction
 *  because the money-moving call needs the verified inquiry/intent. */
async function runFiatAction(
  peridot: PeridotClient,
  action: string,
  inquiry: SubTransferInquiryView | null,
  intent: CheckoutDepositView | null,
): Promise<unknown> {
  if (action === "fiat-transfer") {
    if (!inquiry || !inquiry.accountName) throw new Error("Verified transfer missing — request rejected.");
    return peridot.fiat.transferConfirm(inquiry.id, { beneficiaryAccountName: inquiry.accountName });
  }
  if (action === "fiat-checkout") {
    if (!intent) throw new Error("Verified top-up missing — request rejected.");
    return intent;
  }
  throw new Error(`Unknown action "${action}"`);
}

function isFiatAction(action: string): boolean {
  return action === "fiat-transfer" || action === "fiat-checkout";
}

export function ApproveScreen({ popup }: { popup: PopupParams }) {
  const { peridot } = usePeridot();
  const [phase, setPhase] = useState<Phase>("waiting");
  const [action, setAction] = useState(popup.action);
  const [payload, setPayload] = useState<unknown>(undefined);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Server-quoted fiat state. Summaries are built from THESE (DOKU-side
  // truth), never from opener-supplied amounts — a malicious opener can't
  // display one amount while submitting another.
  const [inquiry, setInquiry] = useState<SubTransferInquiryView | null>(null);
  const [intent, setIntent] = useState<CheckoutDepositView | null>(null);
  // popup.origin is handshake-validated (awaitPopupRequest only accepts
  // messages from window.opener at exactly this origin), so displaying it
  // as the requester is accurate — never trust the URL alone.

  /** Server-side prepare for fiat-transfer: inquiry now, confirm on Approve. */
  const prepareTransfer = useCallback(
    async (p: Record<string, unknown>) => {
      const amountIdr = typeof p.amountIdr === "string" ? p.amountIdr : "";
      const beneficiaryPid = typeof p.beneficiaryPid === "string" ? p.beneficiaryPid : "";
      if (!/^\d+$/.test(amountIdr) || !beneficiaryPid) throw new Error("Transfer request is malformed.");
      const inq = await peridot.fiat.transferInquiry({
        type: "DOKU_SUB_ACCOUNT",
        amountIdr,
        beneficiaryPid,
        ...(typeof p.remark === "string" ? { remark: p.remark } : {}),
      });
      // Tamper guard: the quote must match what the opener asked for, and the
      // recipient must be verified by name. Anything else fails closed.
      if (inq.grossIdr !== amountIdr) throw new Error("Quote mismatch — request rejected.");
      if (!inq.netIdr || !inq.feeIdr || !inq.accountName) {
        throw new Error("Recipient could not be verified — request rejected.");
      }
      setInquiry(inq);
      setSummary(
        `Send ${fmtIdr(inq.netIdr)} to ${beneficiaryPid} (${inq.accountName}) · fee ${fmtIdr(inq.feeIdr)} · total debited ${fmtIdr(inq.grossIdr)}`,
      );
    },
    [peridot],
  );

  /** Server-side prepare for fiat-checkout: create the intent now (moves no
   *  money), show the server quote, navigate to payment on Approve. */
  const prepareCheckout = useCallback(
    async (p: Record<string, unknown>) => {
      const netAmountIdr = typeof p.netAmountIdr === "string" ? p.netAmountIdr : "";
      if (!/^\d+$/.test(netAmountIdr)) throw new Error("Top-up request is malformed.");
      const created = await peridot.fiat.checkoutDeposit(netAmountIdr);
      if (created.netIdr !== netAmountIdr || !created.paymentUrl || !created.grossIdr || !created.feeIdr) {
        throw new Error("Quote mismatch — request rejected.");
      }
      setIntent(created);
      setSummary(
        `Top up ${fmtIdr(created.netIdr)} — you pay ${fmtIdr(created.grossIdr)} (incl. ${fmtIdr(created.feeIdr)} fee). You complete payment on the DOKU page after approval.`,
      );
    },
    [peridot],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        postPopupReady(popup.origin);
        const req = await awaitPopupRequest(popup.origin);
        if (cancelled) return;
        setAction(req.action);
        setPayload(req.payload);
        const p = (req.payload ?? {}) as Record<string, unknown>;
        if (req.action === "fiat-transfer") {
          setPhase("preparing");
          await prepareTransfer(p);
        } else if (req.action === "fiat-checkout") {
          setPhase("preparing");
          await prepareCheckout(p);
        } else {
          setSummary(summarize(req.action, req.payload));
        }
        if (!cancelled) setPhase("review");
      } catch (e) {
        if (!cancelled) {
          setError(signInHint(e));
          setPhase("failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popup.origin]);

  /** Host has no session (user not logged in here): tell them to sign in
   *  first instead of surfacing a raw 401. Matches existing withdraw posture. */
  function signInHint(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    if (/401|unauthorized|not registered|not signed in|session/i.test(message)) {
      return "Sign in to your PeridotID wallet in this window first, then ask the app to retry.";
    }
    return message;
  }

  const deny = useCallback(() => {
    // Best-effort cleanup of server state created during prepare (intent /
    // inquiry rows are harmless if this fails — they expire server-side).
    if (action === "fiat-checkout" && intent) {
      void peridot.fiat.cancelTransaction(intent.id).catch(() => undefined);
    }
    if (action === "fiat-transfer" && inquiry) {
      void peridot.fiat.cancelTransaction(inquiry.id).catch(() => undefined);
    }
    postPopupResult(popup.origin, { ok: false, error: "access_denied" });
    setPhase("done");
  }, [popup.origin, peridot, action, intent, inquiry]);

  const approve = useCallback(async () => {
    setPhase("busy");
    setError(null);
    try {
      const result = isFiatAction(action)
        ? await runFiatAction(peridot, action, inquiry, intent)
        : await runAction(peridot, action, payload);
      // Checkout keeps the window open and navigates itself to the DOKU
      // payment page: same-window navigation from the Approve click can't be
      // popup-blocked, unlike a dapp-side window.open on async RESULT.
      const checkoutUrl =
        action === "fiat-checkout" && intent?.paymentUrl ? intent.paymentUrl : null;
      postPopupResult(
        popup.origin,
        { ok: true, data: result },
        checkoutUrl ? { keepOpen: true } : undefined,
      );
      if (checkoutUrl && typeof window !== "undefined") {
        setPhase("redirecting");
        window.location.assign(checkoutUrl);
        return;
      }
      setPhase("done");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        postPopupResult(popup.origin, { ok: false, error: message });
      } catch {
        // opener gone — show it here instead
      }
      setError(signInHint(message));
      setPhase("review");
    }
  }, [peridot, action, payload, inquiry, intent, popup.origin]);

  return (
    <View style={s.container}>
      <Text style={s.title}>Approve request</Text>
      {phase === "waiting" && <Text style={s.hint}>Waiting for the app…</Text>}
      {phase === "preparing" && <Text style={s.hint}>Loading verified details…</Text>}
      {phase === "redirecting" && <Text style={s.hint}>Opening the payment page…</Text>}
      {phase === "done" && <Text style={s.hint}>Done — you can close this window.</Text>}
      {(phase === "review" || phase === "busy") && summary && (
        <>
          <Text style={s.label}>Requested action</Text>
          <Text selectable style={s.mono}>{summary}</Text>
          <Text style={s.hint}>Requested by {popup.origin}</Text>
          <Text style={s.hint}>Review carefully — approving signs with your passkey.</Text>
        </>
      )}
      {error && <Text style={s.error}>{error}</Text>}
      {(phase === "review" || phase === "busy") && (
        <>
          <UIButton title={phase === "busy" ? "Waiting for passkey…" : "Approve"} onPress={approve} disabled={phase === "busy"} variant="primary" />
          <UIButton title="Deny" onPress={deny} disabled={phase === "busy"} />
        </>
      )}
    </View>
  );
}
