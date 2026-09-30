// Popup approval screen (web only). A third-party dapp opened this page via the
// SDK popup bridge (`?popup=<action>&origin=…`). The request arrives over the
// validated postMessage handshake — never trust the URL alone. On approve, the
// action runs here on the PeridotID origin with this session + passkey (the
// trusted DOM), and the result is posted back to the opener's origin.
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  awaitPopupRequest,
  postPopupReady,
  postPopupResult,
  type CheckoutDepositView,
  type DepositQuoteView,
  type FiatTransferInquiryView,
  type PeridotClient,
  type PopupParams,
} from "@peridotvault/pid-sdk-js";
import { sumTransferFee } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
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

/** Sum two whole-IDR strings (PPN folded into the shown fee lines). */
function sumIdr(a: string, b: string): string {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
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
  inquiry: FiatTransferInquiryView | null,
): Promise<unknown> {
  if (action === "fiat-transfer") {
    if (!inquiry) throw new Error("Verified transfer missing — request rejected.");
    return peridot.fiat.transferConfirm(inquiry.id);
  }
  throw new Error(`Unknown action "${action}"`);
}

function isFiatAction(action: string): boolean {
  return action === "fiat-transfer" || action === "fiat-checkout";
}

/** A 401/expired-session error, as opposed to a real business failure. */
function isSessionError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /401|unauthorized|not registered|not signed in|session/i.test(message);
}

/** Map a session error to actionable copy; anything else stays verbatim. */
function signInHint(e: unknown): string {
  if (isSessionError(e)) {
    return "Sign in to your PeridotID wallet in this window first, then ask the app to retry.";
  }
  return e instanceof Error ? e.message : String(e);
}

export function ApproveScreen({ popup, onNeedAuth }: { popup: PopupParams; onNeedAuth?: () => void }) {
  const { peridot } = usePeridot();
  const [phase, setPhase] = useState<Phase>("waiting");
  const [action, setAction] = useState(popup.action);
  const [payload, setPayload] = useState<unknown>(undefined);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Server-quoted fiat state. Summaries are built from THESE (DOKU-side
  // truth), never from opener-supplied amounts — a malicious opener can't
  // display one amount while submitting another.
  const [inquiry, setInquiry] = useState<FiatTransferInquiryView | null>(null);
  // Top-up checkout: a server quote (moves no money) shown before approval; the
  // intent is created only on Approve, with the chosen method.
  const [checkout, setCheckout] = useState<DepositQuoteView | null>(null);
  const [checkoutReq, setCheckoutReq] = useState<{ netAmountIdr: string; clientId?: string } | null>(null);
  const [checkoutMethod, setCheckoutMethod] = useState<string | null>(null);
  const selectedQuote = checkout?.paymentMethods.find((m) => m.key === checkoutMethod) ?? null;
  // One combined fee line: PeridotID (fee+PPN) + DOKU gateway (fee+PPN).
  const transferFee = checkout ? checkout.transferFeeIdr ?? sumTransferFee(checkout) : "0";
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
        amountIdr,
        beneficiaryPid,
        ...(typeof p.remark === "string" ? { remark: p.remark } : {}),
        ...(typeof p.clientId === "string" ? { clientId: p.clientId } : {}),
      });
      // Tamper guard: the quote must match what the opener asked for.
      if (inq.grossIdr !== amountIdr) throw new Error("Quote mismatch — request rejected.");
      if (!inq.netIdr || !inq.feeIdr) {
        throw new Error("Quote incomplete — request rejected.");
      }
      setInquiry(inq);
      setSummary(
        `Send ${fmtIdr(inq.netIdr)} to ${beneficiaryPid} · fee ${fmtIdr(inq.feeIdr)} · total debited ${fmtIdr(inq.grossIdr)}`,
      );
    },
    [peridot, onNeedAuth],
  );

  /** Server-side prepare for fiat-checkout: quote the top-up now (moves no
   *  money), show the transparent breakdown, and create the intent on Approve. */
  const prepareCheckout = useCallback(
    async (p: Record<string, unknown>) => {
      const netAmountIdr = typeof p.netAmountIdr === "string" ? p.netAmountIdr : "";
      if (!/^\d+$/.test(netAmountIdr)) throw new Error("Top-up request is malformed.");
      const clientId = typeof p.clientId === "string" ? p.clientId : undefined;
      const quote = await peridot.fiat.quoteDeposit({ netAmountIdr, ...(clientId ? { clientId } : {}) });
      if (quote.netIdr !== netAmountIdr || !quote.totalIdr || !quote.peridotFeeIdr) {
        throw new Error("Quote mismatch — request rejected.");
      }
      if (!quote.paymentMethods?.length) {
        throw new Error("No payment methods available for this top-up right now.");
      }
      setCheckout(quote);
      setCheckoutReq({ netAmountIdr, ...(clientId ? { clientId } : {}) });
      setCheckoutMethod((m) => (m && quote.paymentMethods.some((x) => x.key === m) ? m : quote.paymentMethods[0]?.key ?? null));
      setSummary(`Top up ${fmtIdr(quote.netIdr)} — total payment ${fmtIdr(quote.totalIdr)}. You complete payment on the DOKU page after approval.`);
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
          if (isSessionError(e) && onNeedAuth) {
            onNeedAuth();
            return;
          }
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

  const deny = useCallback(() => {
    // Best-effort cleanup of server state created during prepare. The checkout
    // quote moves no money (no row), so only a transfer inquiry needs cancelling.
    if (action === "fiat-transfer" && inquiry) {
      void peridot.fiat.cancelTransaction(inquiry.id).catch(() => undefined);
    }
    postPopupResult(popup.origin, { ok: false, error: "access_denied" });
    setPhase("done");
  }, [popup.origin, peridot, action, inquiry]);

  const approve = useCallback(async () => {
    setPhase("busy");
    setError(null);
    try {
      let result: unknown;
      let checkoutUrl: string | null = null;
      if (action === "fiat-checkout") {
        // Create the intent now, with the approved method, then navigate.
        if (!checkoutReq) throw new Error("Verified top-up missing — request rejected.");
        const created: CheckoutDepositView = await peridot.fiat.checkoutDeposit(
          checkoutReq.netAmountIdr,
          checkoutReq.clientId,
          checkoutMethod ?? undefined,
        );
        result = created;
        checkoutUrl = created.paymentUrl ?? null;
      } else if (isFiatAction(action)) {
        result = await runFiatAction(peridot, action, inquiry);
      } else {
        result = await runAction(peridot, action, payload);
      }
      // Checkout keeps the window open and navigates itself to the DOKU
      // payment page: same-window navigation from the Approve click can't be
      // popup-blocked, unlike a dapp-side async popup.
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
      // Session gone mid-flow: re-authenticate in this window and retry the
      // approval (the popup params persist across the OAuth round-trip). Don't
      // post a failure — the request is still pending.
      if (isSessionError(e) && onNeedAuth) {
        onNeedAuth();
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      try {
        postPopupResult(popup.origin, { ok: false, error: message });
      } catch {
        // opener gone — show it here instead
      }
      setError(signInHint(message));
      setPhase("review");
    }
  }, [peridot, action, payload, inquiry, checkoutReq, checkoutMethod, popup.origin, onNeedAuth]);

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
          {action === "fiat-checkout" && checkout && (
            <View style={styles.breakdown}>
              <Row label="Amount" value={fmtIdr(checkout.netIdr)} />
              {BigInt(transferFee) > 0n && <Row label="Transfer Fee" value={fmtIdr(transferFee)} />}
              {Number(checkout.appFeeIdr) > 0 && <Row label="App Fee" value={fmtIdr(checkout.appFeeIdr)} />}
              <Row label="Total Payment" value={fmtIdr(selectedQuote?.totalIdr ?? checkout.totalIdr)} strong />
            </View>
          )}
          {action === "fiat-checkout" && checkout && phase === "review" && (
            <>
              <Text style={s.label}>Payment method</Text>
              <View style={styles.methods}>
                {checkout.paymentMethods.map((m) => (
                  <TouchableOpacity
                    key={m.key}
                    style={[styles.method, checkoutMethod === m.key && styles.methodActive]}
                    onPress={() => setCheckoutMethod(m.key)}
                    accessibilityLabel={`Pay with ${m.label}`}
                  >
                    <Text style={[styles.methodLabel, checkoutMethod === m.key && styles.methodLabelActive]}>{m.label}</Text>
                    {m.enabled && <Text style={styles.methodFee}>{fmtIdr(sumIdr(m.gatewayFeeIdr, m.gatewayTaxIdr))}</Text>}
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}
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

/** One label/value line of the top-up breakdown. */
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && styles.strong]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  breakdown: { marginTop: 8, gap: 4 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rowLabel: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  rowValue: { fontSize: 13, color: theme.colors.foreground, fontFamily: theme.fonts.mono },
  strong: { fontWeight: "700", color: theme.colors.foreground },
  methods: { gap: 6, marginTop: 2 },
  method: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  methodActive: { borderColor: theme.colors.foreground },
  methodLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  methodLabelActive: { fontWeight: "600" },
  methodFee: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.mono },
});
