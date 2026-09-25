import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { ArrowLeft } from "../icons";
import type { FiatTransferInquiryView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

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
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [remark, setRemark] = useState("");
  const [inquiry, setInquiry] = useState<FiatTransferInquiryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
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
      const inq = await peridot.fiat.transferInquiry({
        amountIdr: trimmed,
        beneficiaryPid: pid,
        ...(remark.trim() ? { remark: remark.trim() } : {}),
      });
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
        <Text selectable style={styles.desc}>{result}</Text>
        <UIButton title="Done" onPress={onDone} variant="primary" />
      </View>
    );
  }

  if (inquiry) {
    return (
      <ScrollView contentContainerStyle={s.container}>
        <TouchableOpacity style={styles.back} onPress={cancel} accessibilityLabel="Back">
          <ArrowLeft size={18} color={theme.colors.foreground} />
          <Text style={styles.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={s.title}>Review transfer</Text>
        <View style={styles.card}>
          <Row label="To" value={inquiry.beneficiaryPid} />
          <Row label="They receive" value={fmtIdr(inquiry.netIdr)} />
          <Row label="Service fee" value={fmtIdr(inquiry.feeIdr)} />
          <Row label="Total debited" value={fmtIdr(inquiry.grossIdr)} />
        </View>
        {error && <Text style={s.error}>{error}</Text>}
        <UIButton title={busy ? "Sending…" : "Confirm & send"} onPress={confirm} disabled={busy} variant="primary" />
        <UIButton title="Back" onPress={cancel} disabled={busy} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.container}>
      <TouchableOpacity style={styles.back} onPress={onDone} accessibilityLabel="Back">
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>
      <Text style={s.title}>Transfer</Text>
      <Text style={s.subtitle}>Send from your balance to any PeridotID user. The fee is quoted from the amount you enter.</Text>
      <Text style={s.label}>Recipient PID</Text>
      <TextInput style={s.input} value={to} onChangeText={setTo} autoCapitalize="none" placeholder="live2dev@pid" placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.label}>Amount (IDR)</Text>
      <TextInput style={s.input} value={amount} onChangeText={setAmount} keyboardType="numeric" placeholder="100000" placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.label}>Note (optional)</Text>
      <TextInput style={s.input} value={remark} onChangeText={setRemark} placeholder="What this is for" placeholderTextColor={theme.colors.mutedForeground} />
      <Text style={s.hint}>Recipient must have a PeridotID account.</Text>
      {error && <Text style={s.error}>{error}</Text>}
      <UIButton title={busy ? "Checking…" : "Continue"} onPress={prepare} disabled={busy || !to || !amount} variant="primary" />
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.field}>
      <Text style={s.label}>{label}</Text>
      <Text style={styles.value} selectable>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  card: { padding: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface, gap: 10 },
  field: { gap: 4 },
  value: { fontSize: 15, color: theme.colors.foreground, fontFamily: theme.fonts.mono },
  desc: { fontSize: 14, color: theme.colors.mutedForeground, lineHeight: 20, fontFamily: theme.fonts.sans },
});
