import { useState } from "react";
import { Text, TextInput, View } from "../shared/primitives";
import { usePeridot } from "../shared/AppContext";
import { styles as s } from "../shared/theme";
import { UIButton } from "../shared/components/UIButton";
import { isNetworkSwitching } from "../shared/network-mode";
import { useNetworkMode } from "../shared/hooks/useNetworkMode";

const LAMPORTS_PER_SOL = 1e9;

/** Map API failures to user-facing copy (mirrors FiatTransferScreen). */
function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/503|disabled|frozen|unavailable/i.test(msg)) {
    return "Sends are temporarily unavailable. Try again later.";
  }
  return msg;
}

export function SendScreen({ onDone }: { onDone: () => void }) {
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
      const res = await peridot.wallet.withdraw({ amount: lamports, asset, to });
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
    <View style={s.container}>
      <Text style={s.title}>Send</Text>
      {/* ANT-333: labels explicitly associated with their inputs. */}
      <label htmlFor="send-to">
        <Text style={s.label}>Destination (Solana address)</Text>
      </label>
      <TextInput
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
        <Text style={s.label}>Amount ({asset === "SOL" ? "SOL" : "raw units"})</Text>
      </label>
      <TextInput
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
        <Text style={s.label}>Asset (SOL or mint address)</Text>
      </label>
      <TextInput
        id="send-asset"
        aria-label="Asset (SOL or mint address)"
        style={s.input}
        className="[--placeholder:var(--color-muted-foreground)]"
        value={asset}
        onChangeText={setAsset}
        autoCapitalize="none"
      />
      <Text style={s.hint}>{asset === "SOL" ? "Amount is in SOL. Confirmed with your passkey (WebAuthn)." : "Token amounts are in raw units. Confirmed with your passkey (WebAuthn)."}</Text>
      {error && <Text style={s.error}>{error}</Text>}
      {result && <Text selectable style={s.mono}>{result}</Text>}
      {net.switching && <Text style={s.hint}>Network is switching — sending is paused until balances reload.</Text>}
      <UIButton title={busy ? "Sending…" : "Send"} onPress={send} disabled={busy || net.switching || !to || !amount} variant="primary" />
      <UIButton title="Back" onPress={goBack} />
    </View>
  );
}