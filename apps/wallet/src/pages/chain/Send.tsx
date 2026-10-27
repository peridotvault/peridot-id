import { useEffect, useRef, useState } from "react";
import { TextField } from "../../shared/components/ui/TextField";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";
import { sendDestinationError } from "../../feat/chain/utils/solanaAddress";
import { isNetworkSwitching } from "../../shared/data/networkMode";
import { useNetworkMode } from "../../shared/hooks/useNetworkMode";
import {
  FeeApprovalDeniedError,
  classifyFeeFailure,
  shortfallMessage,
  type NormalizedFeeQuote,
} from "@peridotvault/pid-sdk-js";
import { FeePanel } from "../../feat/chain/components/FeePanel";
import { gateFeeApproval } from "../../feat/chain/utils/feeReview";
import {
  FIRST_ACTION_APPROVE_TITLE,
  FIRST_ACTION_REVIEW_NOTICE,
  FIRST_ACTION_SENDING_COPY,
  SETUP_PROGRESS_COPY,
  ensureAccountAndActivate,
  isFirstActionQuote,
  isNotActivatedError,
} from "../../feat/chain/utils/firstAction";
import { useQuoteCountdown } from "../../feat/chain/hooks/useQuoteCountdown";

const LAMPORTS_PER_SOL = 1e9;

/** Map API failures to user-facing copy (mirrors FiatTransfer). */
function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/503|disabled|frozen|unavailable/i.test(msg)) {
    return "Sends are temporarily unavailable. Try again later.";
  }
  return msg;
}

/** Taxonomy-first error copy (ANT-557, spec E3); falls back to friendly(). */
function failureCopy(
  e: unknown,
  ctx: { quote: NormalizedFeeQuote | null; asset: string; valueBaseUnits: string | null; balanceBaseUnits: string | null },
): string {
  if (e instanceof FeeApprovalDeniedError) {
    return "Approval cancelled — nothing was signed and no fee was charged.";
  }
  const failure = classifyFeeFailure(e);
  if (failure.code === "INSUFFICIENT_FUNDS" && ctx.quote && ctx.asset === "SOL" && ctx.valueBaseUnits != null && ctx.balanceBaseUnits != null) {
    try {
      return shortfallMessage({
        balanceBaseUnits: ctx.balanceBaseUnits,
        valueBaseUnits: ctx.valueBaseUnits,
        totalFeeBaseUnits: ctx.quote.totalFee,
        decimals: 9,
        symbol: "SOL",
      });
    } catch {
      // Fall through to the generic taxonomy body.
    }
  }
  if (failure.code !== "UNKNOWN") return `${failure.title}: ${failure.body}`;
  return friendly(e);
}

type Phase = "form" | "quoting" | "review" | "sending" | "activating";

export function Send({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  // Block signing while a network switch propagates (ANT-15 req 3) — the
  // request must never land on the wrong chain mid-transition.
  const net = useNetworkMode();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState("SOL");
  const [phase, setPhase] = useState<Phase>("form");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Non-blocking policy notice (ANT-736 NFR-6): present when the signed
  // fee-policy version trails the active policy by one. The send settled
  // fine — this only says the next quote will use a newer policy.
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  // Review-step state: the exact quote the SDK will sign (single-quote
  // continuity — the panel and the ceremony share one quote object).
  const [reviewQuote, setReviewQuote] = useState<NormalizedFeeQuote | null>(null);
  const [reviewValue, setReviewValue] = useState<string | null>(null);
  const [reviewBalance, setReviewBalance] = useState<string | null>(null);
  // First-action (ANT-731 WS4): the first send also sets up the on-chain
  // account — no separate user step. Detected best-effort before quoting
  // (local activation view) and confirmed by the quote envelope (WS1 §7.1).
  const [firstAction, setFirstAction] = useState(false);
  // Pre-lazy backends refuse the submit ("must be activated"); the flow then
  // runs the passkey-signed setup inline and retries exactly once.
  const setupRetriedRef = useRef(false);
  const decisionRef = useRef<((ok: boolean) => void) | null>(null);
  // The catch path runs in the closure of the render that started the send —
  // render state is stale by then, so the error context lives in a ref.
  const reviewRef = useRef<{ quote: NormalizedFeeQuote | null; value: string | null; balance: string | null }>({
    quote: null,
    value: null,
    balance: null,
  });

  // Live expiry for Approve gating (the panel owns the countdown display;
  // this tick re-renders the gate every second).
  const countdown = useQuoteCountdown(reviewQuote);

  // ANT-341 FR1: move focus to the error on failed submit (SR + keyboard).
  useEffect(() => {
    if (error) document.getElementById("send-error")?.focus?.();
  }, [error]);

  // Focus the review heading when the fee panel appears (SR + keyboard).
  useEffect(() => {
    if (phase === "review") document.getElementById("send-review")?.focus?.();
  }, [phase]);

  // Unmount while a decision is pending = denial (fail closed, nothing signs).
  useEffect(
    () => () => {
      decisionRef.current?.(false);
      decisionRef.current = null;
    },
    [],
  );

  // The SDK expects raw lamports / token units. SOL entries are entered in SOL and
  // converted here; token entries must be whole raw units.
  const toLamports = (input: string): string | null => {
    const trimmed = input.trim();
    if (asset === "SOL") {
      const sol = Number(trimmed);
      if (!Number.isFinite(sol) || sol <= 0) return null;
      return String(BigInt(Math.round(sol * LAMPORTS_PER_SOL)));
    }
    if (!/^\d+$/.test(trimmed)) return null;
    return trimmed;
  };

  const ctxForError = () => ({
    quote: reviewRef.current.quote,
    asset,
    valueBaseUnits: reviewRef.current.value,
    balanceBaseUnits: reviewRef.current.balance,
  });

  const send = async () => {
    setError(null);
    setResult(null);
    setPolicyNotice(null);
    try {
      if (isNetworkSwitching()) {
        setError("Network is switching — wait a moment, then try again.");
        return;
      }
      const lamports = toLamports(amount);
      if (lamports === null) {
        setError(asset === "SOL" ? "Enter an amount greater than 0." : "Token amounts must be whole raw units.");
        return;
      }
      const destError = sendDestinationError(to);
      if (destError) {
        setError(destError);
        return;
      }
      setPhase("quoting");
      // Best-effort first-action detection (fail-open: unreadable status
      // takes the normal path; the quote envelope + the setup-and-retry
      // below still cover a first send).
      const first = await peridot.wallet
        .activation()
        .then((act) => !(typeof act === "object" && act !== null && "statusCode" in act) && act.status !== "active")
        .catch(() => false);
      setFirstAction(first);
      // Balance is display-only here (shortfall line + Approve gating); the
      // chain still enforces funds fail-closed at submit time. Unreadable
      // balance hides the line instead of blocking.
      const balance = await peridot.wallet.getBalance().catch(() => null);
      const balanceBaseUnits = typeof balance === "number" && Number.isFinite(balance) ? String(Math.floor(balance)) : null;
      const res = await peridot.wallet.withdraw(
        { amount: lamports, asset, to: to.trim() },
        {
          // Pre-approval gate (ANT-557): the SDK fetched the quote and waits.
          // Show it, and resolve true only when the user approves the panel —
          // the passkey ceremony runs after, on this same quote.
          onQuote: async (quote) => {
            setReviewQuote(quote);
            setReviewValue(lamports);
            setReviewBalance(balanceBaseUnits);
            reviewRef.current = { quote, value: lamports, balance: balanceBaseUnits };
            setPhase("review");
            return new Promise<boolean>((resolve) => {
              decisionRef.current = resolve;
            });
          },
        },
      );
      decisionRef.current = null;
      const feeSol = Number(BigInt(res.networkFeeLamports) + BigInt(res.protocolFeeLamports)) / LAMPORTS_PER_SOL;
      // NFR-6: signed version one back — the send settled, the next quote
      // just uses a newer policy. Non-blocking notice, never an error.
      if (res.feePolicyWarning) setPolicyNotice(res.feePolicyWarning);
      if (res.status === "confirmed") {
        setResult(
          `Sent and confirmed on-chain. Network fee ${feeSol.toFixed(6)} SOL was reimbursed from your balance.\nSignature: ${res.signature}`,
        );
      } else {
        // Server already waited ~8s; give it a few more before reporting pending.
        const outcome = await peridot.wallet.waitForConfirmation(res.signature, 6, 1200).catch(() => "pending");
        if (outcome === "confirmed") {
          setResult(
            `Sent and confirmed on-chain. Network fee ${feeSol.toFixed(6)} SOL was reimbursed from your balance.\nSignature: ${res.signature}`,
          );
        } else if (outcome === "failed") {
          setError("The transaction failed on-chain — the Solana network rejected it. No funds were moved.");
        } else {
          setError(
            "Transaction submitted but not yet confirmed. Check your Activity in a moment — no funds were lost.",
          );
        }
      }
      setPhase("form");
      setReviewQuote(null);
      setFirstAction(false);
      setupRetriedRef.current = false;
      reviewRef.current = { quote: null, value: null, balance: null };
    } catch (e) {
      // ANT-333: friendly server-error mapping instead of a raw dump,
      // taxonomy-first (ANT-557 E3) so each failure class reads correctly.
      decisionRef.current = null;
      // Pre-lazy backend refusing a first send: run the passkey-signed setup
      // inline and retry once — still one flow, no separate user step.
      // (Lazy backends never hit this: the first submit already includes it.)
      if (isNotActivatedError(e) && !setupRetriedRef.current) {
        setupRetriedRef.current = true;
        setPhase("activating");
        setReviewQuote(null);
        reviewRef.current = { quote: null, value: null, balance: null };
        try {
          const setupWarning = await ensureAccountAndActivate(peridot);
          if (setupWarning) setPolicyNotice(setupWarning);
        } catch (setupError) {
          setPhase("form");
          setError(setupError instanceof Error ? setupError.message : String(setupError));
          return;
        }
        return send();
      }
      const copy = failureCopy(e, ctxForError());
      setPhase("form");
      setReviewQuote(null);
      setFirstAction(false);
      setupRetriedRef.current = false;
      reviewRef.current = { quote: null, value: null, balance: null };
      setError(copy);
    }
  };

  const approve = () => {
    setError(null);
    setPhase("sending");
    decisionRef.current?.(true);
    decisionRef.current = null;
  };

  const cancelReview = () => {
    decisionRef.current?.(false);
    decisionRef.current = null;
    // The onQuote denial rejects into send()'s catch, which reports the
    // cancellation copy and returns to the form.
  };

  // ANT-333: confirm before abandoning an in-flight send.
  const busy = phase === "quoting" || phase === "sending" || phase === "activating";
  const goBack = () => {
    if (phase === "review") {
      cancelReview();
      return;
    }
    if (busy && !window.confirm("A send is in progress. Go back anyway?")) return;
    onDone();
  };

  const gate =
    reviewQuote != null
      ? gateFeeApproval({
          quote: reviewQuote,
          asset,
          valueBaseUnits: reviewValue,
          balanceBaseUnits: reviewBalance,
          nowMs: Date.now(),
        })
      : null;
  const approveBlocked = countdown.expired || gate == null || gate.ok === false;
  // First-action comes from the local pre-flight OR the quote envelope (WS1
  // §7.1) — either source shows the inclusion notice, never an extra step.
  const showFirstAction = firstAction || isFirstActionQuote(reviewQuote);
  const approveTitle = countdown.expired ? "Quote expired" : showFirstAction ? FIRST_ACTION_APPROVE_TITLE : "Approve & sign";

  return (
    <div style={s.container} className="flex flex-col">
      <PushHeader onBack={goBack} title="Send" />
      {phase === "form" && (
        <>
          {/* ANT-333: labels explicitly associated with their inputs. */}
          <label htmlFor="send-to">
            <span style={s.label}>Destination (Solana address)</span>
          </label>
          <TextField
            id="send-to"
            aria-label="Destination (Solana address)"
            style={s.input}
            className="[--placeholder:var(--color-muted-foreground)]"
            value={to}
            onChangeText={setTo}
            autoCapitalize="none"
            placeholder="Recipient address"
           />
          <label htmlFor="send-amount">
            <span style={s.label}>Amount ({asset === "SOL" ? "SOL" : "raw units"})</span>
          </label>
          <TextField
            id="send-amount"
            aria-label={`Amount (${asset === "SOL" ? "SOL" : "raw units"})`}
            style={s.input}
            className="[--placeholder:var(--color-muted-foreground)]"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder={asset === "SOL" ? "0.5" : "0"}
           />
          <label htmlFor="send-asset">
            <span style={s.label}>Asset (SOL or mint address)</span>
          </label>
          <TextField
            id="send-asset"
            aria-label="Asset (SOL or mint address)"
            style={s.input}
            className="[--placeholder:var(--color-muted-foreground)]"
            value={asset}
            onChangeText={setAsset}
            autoCapitalize="none"
           />
          <p style={s.hint}>{asset === "SOL" ? "Amount is in SOL. Confirmed with your passkey (WebAuthn)." : "Token amounts are in raw units. Confirmed with your passkey (WebAuthn)."}</p>
          {error && <p role="alert" tabIndex={-1} id="send-error" style={s.error}>{error}</p>}
          {result && <span role="status" style={s.mono} className="select-text">{result}</span>}
          {policyNotice && <p role="status" style={s.hint}>Note: {policyNotice}</p>}
          {net.switching && <p style={s.hint}>Network is switching — sending is paused until balances reload.</p>}
          <UIButton title="Review fees" onPress={send} disabled={!to || !amount || net.switching} variant="primary" />
        </>
      )}
      {phase === "quoting" && <p role="status" style={s.hint}>Loading fee quote…</p>}
      {phase === "review" && reviewQuote && (
        <>
          <h2 id="send-review" tabIndex={-1} style={s.title}>Review fees</h2>
          <p style={s.hint}>
            Send {asset === "SOL" ? `${Number(reviewValue) / LAMPORTS_PER_SOL} SOL` : `${reviewValue} (raw units)`} to {to.trim()}.
            Nothing is signed until you approve below.
          </p>
          {asset === "SOL" && reviewBalance == null && (
            <p style={s.hint}>Balance unavailable — the shortfall check is skipped; on-chain checks still apply.</p>
          )}
          <FeePanel
            quote={reviewQuote}
            assetSymbol="SOL"
            decimals={9}
            valueBaseUnits={asset === "SOL" ? reviewValue : null}
            balanceBaseUnits={asset === "SOL" ? reviewBalance : null}
          />
          {showFirstAction && <p style={s.hint}>{FIRST_ACTION_REVIEW_NOTICE}</p>}
          {error && <p role="alert" tabIndex={-1} id="send-error" style={s.error}>{error}</p>}
          <UIButton
            title={approveTitle}
            onPress={approve}
            disabled={approveBlocked}
            variant="primary"
          />
          <UIButton title="Cancel" onPress={cancelReview} />
        </>
      )}
      {phase === "sending" && (
        <p role="status" style={s.hint}>
          {firstAction ? FIRST_ACTION_SENDING_COPY : "Waiting for passkey… approve in your authenticator to sign the quoted send."}
        </p>
      )}
      {phase === "activating" && <p role="status" style={s.hint}>{SETUP_PROGRESS_COPY}</p>}
    </div>
  );
}
