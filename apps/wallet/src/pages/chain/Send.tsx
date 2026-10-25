import { useEffect, useState } from "react";
import { TextField } from "../../shared/components/ui/TextField";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { PushHeader } from "../../shared/components/ui/PushHeader";
import { UIButton } from "../../shared/components/ui/UIButton";
import { sendDestinationError } from "../../feat/chain/utils/solanaAddress";
import { isNetworkSwitching } from "../../shared/data/networkMode";
import { useNetworkMode } from "../../shared/hooks/useNetworkMode";

const LAMPORTS_PER_SOL = 1e9;

/** Map API failures to user-facing copy (mirrors FiatTransfer). */
function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/503|disabled|frozen|unavailable/i.test(msg)) {
    return "Sends are temporarily unavailable. Try again later.";
  }
  return msg;
}

export function Send({ onDone }: { onDone: () => void }) {
  const { peridot } = usePeridot();
  // Block signing while a network switch propagates (ANT-15 req 3) — the
  // request must never land on the wrong chain mid-transition.
  const net = useNetworkMode();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState("SOL");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ANT-341 FR1: move focus to the error on failed submit (SR + keyboard).
  useEffect(() => {
    if (error) document.getElementById("send-error")?.focus?.();
  }, [error]);

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

  const send = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
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
      const res = await peridot.wallet.withdraw({ amount: lamports, asset, to: to.trim() });
      const feeSol = Number(BigInt(res.networkFeeLamports) + BigInt(res.protocolFeeLamports)) / LAMPORTS_PER_SOL;
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
    } catch (e) {
      // ANT-333: friendly server-error mapping instead of a raw dump.
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  // ANT-333: confirm before abandoning an in-flight send.
  const goBack = () => {
    if (busy && !window.confirm("A send is in progress. Go back anyway?")) return;
    onDone();
  };

  return (
    <div style={s.container} className="flex flex-col">
      <PushHeader onBack={goBack} title="Send" />
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
      {net.switching && <p style={s.hint}>Network is switching — sending is paused until balances reload.</p>}
      <UIButton title={busy ? "Sending…" : "Send"} onPress={send} disabled={busy || net.switching || !to || !amount} variant="primary" />
    </div>
  );
}