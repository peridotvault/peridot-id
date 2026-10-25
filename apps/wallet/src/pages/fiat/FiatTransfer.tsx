import { useEffect, useState } from "react";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { TextField } from "../../shared/components/ui/TextField";
import type { FiatTransferInquiryView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";
import { isNetworkSwitching, isTestnetMode } from "../../shared/data/networkMode";
import { useNetworkMode } from "../../shared/hooks/useNetworkMode";

function fmtIdr(units: string): string {
  return `Rp${Number(units).toLocaleString("id-ID")}`;
}

/** Map API failures to user-facing copy. */
function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/503|disabled|frozen|unavailable/i.test(msg)) {
    return "Transfers are temporarily unavailable. Try again later.";
  }
  return msg;
}

/**
 * First-party send on the fiat ledger (GROSS-in): enter the recipient PID and
 * the gross amount, review the server quote (fee + net), then confirm. The
 * two-phase inquiry/confirm mirrors the SDK's fiat transfer; only an
 * allowlisted app account is a valid recipient (phase-1 policy).
 */
export function FiatTransfer({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  // Fiat-out is gated in Testnet Mode (ANT-15 req 4): the fiat ledger is
  // real money, mainnet-only. Signing also stays blocked mid-transition.
  const net = useNetworkMode();
  const gated = net.testnet;
  const frozen = net.switching;
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [remark, setRemark] = useState("");
  const [inquiry, setInquiry] = useState<FiatTransferInquiryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // ANT-341 FR1: move focus to the error on failed submit (SR + keyboard).
  // Form and review phases render different error nodes; one is mounted.
  useEffect(() => {
    if (!error) return;
    (document.getElementById("fiat-transfer-error") ?? document.getElementById("fiat-transfer-error-review"))?.focus?.();
  }, [error]);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isTestnetMode()) {
        setError("Transfers are disabled in Testnet Mode — switch back to Mainnet in Settings.");
        return;
      }
      if (isNetworkSwitching()) {
        setError("Network is switching — wait a moment, then try again.");
        return;
      }
      const trimmed = amount.replace(/\D/g, "");
      if (!/^\d+$/.test(trimmed) || BigInt(trimmed) <= 0n) {
        setError("Enter an amount greater than 0.");
        return;
      }
      const pid = to.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,20}@pid$/.test(pid)) {
        setError("Enter a recipient PID like rani@pid.");
        return;
      }
      const input = { amountIdr: trimmed, beneficiaryPid: pid, ...(remark.trim() ? { remark: remark.trim() } : {}) };
      // Popup mode (third-party embed): one popup ceremony does inquiry +
      // verified review + confirm; the inline two-phase path is first-party only.
      if (peridot.fiat.isDelegated) {
        const res = await peridot.fiat.transferViaPopup(input);
        setResult(
          res.status === "posted"
            ? `Sent ${fmtIdr(res.amountIdr)} to ${pid}.`
            : "Transfer submitted — check Activity for its status.",
        );
        return;
      }
      const inq = await peridot.fiat.transferInquiry(input);
      setInquiry(inq);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!inquiry) return;
    setBusy(true);
    setError(null);
    try {
      if (isTestnetMode() || isNetworkSwitching()) {
        setError("Transfers are unavailable right now — check the network banner in Settings.");
        return;
      }
      const res = await peridot.fiat.transferConfirm(inquiry.id);
      if (res.status === "posted") {
        setResult(`Sent ${fmtIdr(res.amountIdr)} to ${inquiry.beneficiaryPid}.`);
      } else {
        setResult("Transfer submitted — check Activity for its status.");
      }
      setInquiry(null);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!inquiry) return;
    setBusy(true);
    setError(null);
    try {
      await peridot.fiat.cancelTransaction(inquiry.id).catch(() => undefined);
    } finally {
      setInquiry(null);
      setBusy(false);
    }
  };

  if (result) {
    return (
      <div style={s.container} className="flex flex-col">
        <span style={s.title}>Sent</span>
        <span className="select-text font-sans text-sm leading-5 text-muted-foreground">{result}</span>
        <UIButton title="Done" onPress={onDone} variant="primary" />
      </div>
    );
  }

  if (inquiry) {
    return (
      <ScrollArea contentContainerStyle={s.container}>
        <PushHeader onBack={cancel} title="Review transfer" />
        <div className="flex flex-col gap-2.5 border border-border bg-surface p-3">
          <Row label="To" value={inquiry.beneficiaryPid} />
          <Row label="They receive" value={fmtIdr(inquiry.netIdr)} />
          <Row label="Service fee" value={fmtIdr(inquiry.feeIdr)} />
          <Row label="Total debited" value={fmtIdr(inquiry.grossIdr)} />
        </div>
        {error && <p role="alert" tabIndex={-1} id="fiat-transfer-error-review" style={s.error}>{error}</p>}
        <UIButton title={busy ? "Sending…" : "Confirm & send"} onPress={confirm} disabled={busy || gated || frozen} variant="primary" />
      </ScrollArea>
    );
  }

  return (
    <ScrollArea contentContainerStyle={s.container}>
      <PushHeader onBack={onDone} title="Transfer" />
      <p style={s.subtitle}>Send from your balance to any PeridotID user. The fee is quoted from the amount you enter.</p>
      {gated && (
        <div className="flex flex-col border border-border bg-muted p-3">
          <span className="font-sans text-sm font-semibold text-foreground">Disabled in Testnet Mode</span>
          <span className="font-sans text-sm leading-5 text-muted-foreground">
            Fiat transfers move real money — switch back to Mainnet in Settings to send.
          </span>
        </div>
      )}
      {frozen && !gated && <p style={s.hint}>Network is switching — transfers pause until balances reload.</p>}
      <label htmlFor="fiat-to">
        <span style={s.label}>Recipient PID</span>
      </label>
      <TextField id="fiat-to" aria-label="Recipient PID" style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={to} onChangeText={setTo} autoCapitalize="none" placeholder="live2dev@pid"  />
      <label htmlFor="fiat-amount">
        <span style={s.label}>Amount (IDR)</span>
      </label>
      <TextField id="fiat-amount" aria-label="Amount (IDR)" style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="100000"  />
      <label htmlFor="fiat-note">
        <span style={s.label}>Note (optional)</span>
      </label>
      <TextField id="fiat-note" aria-label="Note (optional)" style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={remark} onChangeText={setRemark} placeholder="What this is for"  />
      <p style={s.hint}>Recipient must have a PeridotID account.</p>
      {error && <p role="alert" tabIndex={-1} id="fiat-transfer-error" style={s.error}>{error}</p>}
      <UIButton title={busy ? "Checking…" : "Continue"} onPress={prepare} disabled={busy || gated || frozen || !to || !amount} variant="primary" />
    </ScrollArea>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span style={s.label}>{label}</span>
      <span className="select-text font-mono text-base text-foreground">{value}</span>
    </div>
  );
}
