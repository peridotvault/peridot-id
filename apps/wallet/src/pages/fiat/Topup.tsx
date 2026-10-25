import { useEffect, useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { TextField } from "../../shared/components/ui/TextField";
import { openExternalUrl } from "../../shared/app/openExternal";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";
import { fmtIdr } from "../../shared/data/fiat";
import { isNetworkSwitching, isTestnetMode } from "../../shared/data/networkMode";
import { useNetworkMode } from "../../shared/hooks/useNetworkMode";
import { FiatQuoteBreakdown } from "../../feat/fiat/components/FiatQuoteBreakdown";
import { digitsOnly, groupDigits, MIN_NET_IDR } from "../../feat/fiat/utils/topupAmount";
import { useDepositQuote } from "../../feat/fiat/hooks/useDepositQuote";
import { useCheckoutSync } from "../../feat/fiat/hooks/useCheckoutSync";

/**
 * Top up the internal fiat ledger via DOKU Checkout. Enter the NET amount you
 * want credited; the PeridotID checkout summary shows Amount, the combined
 * Transfer Fee (PeridotID fee + PPN, DOKU gateway fee + PPN), any app fee, and
 * the Total Payment — so you know the final amount before DOKU. Pay opens the
 * DOKU-hosted page (all banks, QRIS, e-money, cards). After paying, tap Check
 * payment status (auto-checked once on return) — your Saldo updates with the
 * exact quoted net once the payment is confirmed.
 */
export function Topup({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  const [net, setNet] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ANT-341 FR1: move focus to the error on failed submit (SR + keyboard).
  useEffect(() => {
    if (error) document.getElementById("topup-error")?.focus?.();
  }, [error]);
  const q = useDepositQuote(peridot, net, setError);
  const sync = useCheckoutSync(peridot);
  // DOKU checkout moves real money — mainnet-only, and paused mid-transition
  // (ANT-15 req 4). Testnet users top up with devnet SOL, not rupiah.
  const nm = useNetworkMode();
  const gated = nm.testnet;
  const frozen = nm.switching;

  const digits = net.replace(/\D/g, "");
  const belowMin = /^\d+$/.test(digits) && BigInt(digits) > 0n && BigInt(digits) < MIN_NET_IDR;

  const openUrl = (url: string) => {
    openExternalUrl(url).catch(() => setError("Could not open the payment page."));
  };

  const createCheckout = async () => {
    setBusy(true);
    setError(null);
    sync.setPending(null);
    try {
      if (isTestnetMode()) {
        setError("Top-ups are disabled in Testnet Mode — real-money checkout is mainnet-only.");
        return;
      }
      if (isNetworkSwitching()) {
        setError("Network is switching — wait a moment, then try again.");
        return;
      }
      if (!/^\d+$/.test(digits) || BigInt(digits) <= 0n) {
        setError("Enter the net amount you want credited.");
        return;
      }
      if (BigInt(digits) < MIN_NET_IDR) {
        setError("Minimum top-up is Rp50.000.");
        return;
      }
      if (!q.method) {
        setError("No payment methods available right now.");
        return;
      }
      const deposit = await peridot.fiat.checkoutDeposit(digits, undefined, q.method);
      sync.setPending(deposit);
      setNet("");
      q.setQuote(null);
      // Take the user straight to payment — the manual button below remains
      // as fallback when deep-linking is blocked.
      openUrl(deposit.paymentUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollArea contentContainerStyle={s.container}>
      <PushHeader
        onBack={onDone}
        title="Top Up"
        subtitle="Enter what you want credited — you pay that plus the fees shown below."
      />
      {gated && (
        <div className="flex flex-col border border-border bg-muted p-3">
          <span className="font-sans text-sm font-semibold text-foreground">Disabled in Testnet Mode</span>
          <span className="font-sans text-sm leading-5 text-muted-foreground">
            Real-money checkout is mainnet-only — switch back to Mainnet in Settings to top up.
          </span>
        </div>
      )}
      {frozen && !gated && <p style={s.hint}>Network is switching — top-ups pause until balances reload.</p>}

      {/* ANT-341 FR7: submit errors render above the fold (no scroll to find them). */}
      {error && <p role="alert" tabIndex={-1} id="topup-error" style={s.error}>{error}</p>}

      <div className="flex flex-col mt-3 gap-1.5 border border-border bg-surface p-3">
        <label htmlFor="topupAmount">
          <span style={s.label}>Amount credited to you (IDR)</span>
        </label>
        <TextField id="topupAmount" aria-label="Amount credited to you (IDR)" style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={groupDigits(net)} onChangeText={(t) => setNet(digitsOnly(t))} keyboardType="numeric" placeholder="50.000"  />
        {belowMin && <p role="alert" style={s.error}>Minimum top-up is Rp50.000.</p>}

        {q.quote && (
          <>
            {q.noMethods ? (
              <p role="alert" style={s.error}>No payment methods available right now. Try again later.</p>
            ) : (
              <FiatQuoteBreakdown
                quote={q.quote}
                transferFee={q.transferFee}
                selectedTotalIdr={q.selected?.totalIdr ?? q.quote.totalIdr}
                method={q.method}
                editable
                onMethod={q.setMethod}
              />
            )}
          </>
        )}

        <UIButton
          title={busy ? "Creating…" : q.selected ? `Pay ${fmtIdr(q.selected.totalIdr)}` : "Pay"}
          onPress={createCheckout}
          disabled={busy || gated || frozen || !q.quote || belowMin || q.noMethods}
          variant="primary"
        />
        {sync.pending && (
          <div className="flex flex-col gap-1.5">
            <p style={s.hint}>Complete your payment, then tap Check status — your Saldo updates once the payment is confirmed.</p>
            <UIButton
              title={sync.syncing ? "Checking…" : "Check payment status"}
              onPress={() => sync.checkStatus(sync.pending!)}
              disabled={sync.syncing}
            />
            <UIButton title="Open payment page" onPress={() => openUrl(sync.pending!.paymentUrl)} />
          </div>
        )}
        {sync.syncMsg && <p role="status" style={s.hint}>{sync.syncMsg}</p>}
      </div>

      <p style={s.hint}>
        Minimum top-up {fmtIdr(MIN_NET_IDR.toString())} net. Verified apps pay a Rp0 PeridotID fee. Tap Check payment status after paying — your Saldo updates once confirmed.
      </p>
    </ScrollArea>
  );
}
