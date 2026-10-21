import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "../shared/primitives";
import type { FiatTransferInquiryView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { BackButton } from "../shared/components/BackButton";
import { UIButton } from "../shared/components/UIButton";
import { isNetworkSwitching, isTestnetMode } from "../shared/network-mode";
import { useNetworkMode } from "../shared/hooks/useNetworkMode";

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
export function FiatTransferScreen({ onDone }: { onDone: () => void }) {
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
      <View style={s.container}>
        <Text style={s.title}>Sent</Text>
        <Text selectable className="font-sans text-sm leading-5 text-muted-foreground">{result}</Text>
        <UIButton title="Done" onPress={onDone} variant="primary" />
      </View>
    );
  }

  if (inquiry) {
    return (
      <ScrollView contentContainerStyle={s.container}>
        <BackButton onPress={cancel} />
        <Text style={s.title}>Review transfer</Text>
        <View className="gap-2.5 border border-border bg-surface p-3">
          <Row label="To" value={inquiry.beneficiaryPid} />
          <Row label="They receive" value={fmtIdr(inquiry.netIdr)} />
          <Row label="Service fee" value={fmtIdr(inquiry.feeIdr)} />
          <Row label="Total debited" value={fmtIdr(inquiry.grossIdr)} />
        </View>
        {error && <Text role="alert" tabIndex={-1} id="fiat-transfer-error-review" style={s.error}>{error}</Text>}
        <UIButton title={busy ? "Sending…" : "Confirm & send"} onPress={confirm} disabled={busy || gated || frozen} variant="primary" />
        <UIButton title="Back" onPress={cancel} disabled={busy} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.container}>
      <BackButton onPress={onDone} />
      <Text style={s.title}>Transfer</Text>
      <Text style={s.subtitle}>Send from your balance to any PeridotID user. The fee is quoted from the amount you enter.</Text>
      {gated && (
        <View className="border border-border bg-muted p-3">
          <Text className="font-sans text-[13px] font-semibold text-foreground">Disabled in Testnet Mode</Text>
          <Text className="font-sans text-[13px] leading-5 text-muted-foreground">
            Fiat transfers move real money — switch back to Mainnet in Settings to send.
          </Text>
        </View>
      )}
      {frozen && !gated && <Text style={s.hint}>Network is switching — transfers pause until balances reload.</Text>}
      <label htmlFor="fiat-to">
        <Text style={s.label}>Recipient PID</Text>
      </label>
      <TextInput id="fiat-to" aria-label="Recipient PID" style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={to} onChangeText={setTo} autoCapitalize="none" placeholder="live2dev@pid" />
      <label htmlFor="fiat-amount">
        <Text style={s.label}>Amount (IDR)</Text>
      </label>
      <TextInput id="fiat-amount" aria-label="Amount (IDR)" style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="100000" />
      <label htmlFor="fiat-note">
        <Text style={s.label}>Note (optional)</Text>
      </label>
      <TextInput id="fiat-note" aria-label="Note (optional)" style={s.input} className="[--placeholder:var(--color-muted-foreground)]" value={remark} onChangeText={setRemark} placeholder="What this is for" />
      <Text style={s.hint}>Recipient must have a PeridotID account.</Text>
      {error && <Text role="alert" tabIndex={-1} id="fiat-transfer-error" style={s.error}>{error}</Text>}
      <UIButton title={busy ? "Checking…" : "Continue"} onPress={prepare} disabled={busy || gated || frozen || !to || !amount} variant="primary" />
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-1">
      <Text style={s.label}>{label}</Text>
      <Text className="font-mono text-[15px] text-foreground" selectable>{value}</Text>
    </View>
  );
}
