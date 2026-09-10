import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { ArrowLeft, Rocket, Info, Copy } from "../icons";
import type { Account, Authority } from "@peridotvault/pid-types";
import type { ActivationView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";

const LAMPORTS_PER_SOL = 1e9;

export function ActivationScreen({ onDone, goPasskey }: { onDone: () => void; goPasskey: () => void }) {
  const { peridot } = usePeridot();
  const [account, setAccount] = useState<Account | null>(null);
  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      let acc = await peridot.wallet.me();
      if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
      if ("statusCode" in acc) throw new Error("Failed to create account");
      setAccount(acc as Account);
      try {
        const act = await peridot.wallet.activation((acc as Account).id);
        if (!("statusCode" in act)) setActivation(act as ActivationView);
      } catch {
        /* activation read failed — leave null */
      }
      try {
        const creds = await peridot.passkey.list();
        setPasskeys(Array.isArray(creds) ? (creds as Authority[]) : []);
      } catch {
        setPasskeys([]);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const copyAddress = async () => {
    const addr = activation?.smartAccountAddress;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — nothing to do
    }
  };

  const activate = async () => {
    if (!account) return;
    setBusy(true);
    setError(null);
    try {
      const res = await peridot.wallet.activate(account.id);
      if ("statusCode" in res) {
        const msg = Array.isArray(res.message) ? res.message.join(" ") : (res.message as string);
        throw new Error(msg);
      }
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const st = activation?.status;
  const requiredSol = activation ? Number(activation.requiredLamports) / LAMPORTS_PER_SOL : 0;
  const balanceSol = activation ? Number(activation.balanceLamports) / LAMPORTS_PER_SOL : 0;
  const ready = st === "ready";
  const active = st === "active";
  const hasPasskey = passkeys.length > 0;
  const addr = activation?.smartAccountAddress ?? null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.back} onPress={onDone}>
        <ArrowLeft size={18} color={theme.colors.foreground} />
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>

      <View style={styles.titleRow}>
        <Rocket size={22} color={theme.colors.foreground} />
        <Text style={s.title}>Activate Account</Text>
      </View>

      <View style={s.card}>
        <Text style={[s.label, { marginBottom: 6 }]}>What happens</Text>
        <Text style={styles.desc}>
          Activation creates your on-chain Solana account (the Peridot smart account / PDA).
          Until activated, your deposit address exists but has no on-chain account.
        </Text>
      </View>

      <View style={s.card}>
        <Text style={[s.label, { marginBottom: 6 }]}>Who pays</Text>
        <Text style={styles.desc}>
          The activation cost (rent + network fee + a small margin) is covered from the SOL
          in your own wallet at activation time. Peridot fronts the network fee from its own
          account and is reimbursed in the same transaction. There is no recurring
          sponsorship.
        </Text>
      </View>

      {!active && (
        <View style={s.card}>
          <Text style={[s.label, { marginBottom: 6 }]}>Your deposit address</Text>
          <Text style={styles.desc}>
            Send SOL to this address to fund your wallet and cover activation. The cost
            currently requires about {requiredSol.toFixed(4)} SOL.
          </Text>
          <TouchableOpacity style={styles.addressBox} onPress={copyAddress}>
            <Text selectable style={[s.mono, styles.addressText]}>
              {addr ? `${addr.slice(0, 8)}…${addr.slice(-8)}` : "—"}
            </Text>
            {copied ? (
              <Text style={styles.copied}>Copied</Text>
            ) : (
              <Copy size={14} color={theme.colors.mutedForeground} />
            )}
          </TouchableOpacity>
          <Text style={s.hint}>
            Balance: {balanceSol.toFixed(4)} SOL{balanceSol < requiredSol ? ` — top up to at least ${requiredSol.toFixed(4)} SOL` : ""}.
          </Text>
        </View>
      )}

      {error && <Text style={s.error}>{error}</Text>}

      {activation && !active && (
        <View style={s.card}>
          <Text style={[s.label, { marginBottom: 6 }]}>Status</Text>
          <View style={styles.statusRow}>
            <Info size={16} color={theme.colors.mutedForeground} />
            <Text style={styles.desc}>
              {ready
                ? `Ready to activate.`
                : st === "inactivated"
                  ? "Deposit SOL to your address above first."
                  : st === "insufficient"
                    ? `Need at least ${requiredSol.toFixed(4)} SOL to cover activation (you have ${balanceSol.toFixed(4)}).`
                    : st === "activating"
                      ? "Activating on-chain…"
                      : "Funds received — activation is checked shortly."}
            </Text>
          </View>
        </View>
      )}

      {active && (
        <View style={styles.activeCard}>
          <Text style={styles.activeTitle}>Account activated</Text>
          <Text style={styles.desc}>
            Your smart account is live on-chain. The activation cost was reimbursed to
            Peridot from your deposit.
          </Text>
        </View>
      )}

      {!hasPasskey ? (
        <UIButton title="Create a passkey first" onPress={goPasskey} disabled={busy} variant="primary" />
      ) : ready ? (
        <UIButton title={busy ? "Activating…" : "Activate Account"} onPress={activate} disabled={busy} variant="primary" />
      ) : null}

      {error && <Text style={styles.errHint}>Activation failures deduct nothing — your deposit stays in place. Retry if the message suggests so.</Text>}

      <UIButton title="Back" onPress={onDone} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 14 },
  back: { flexDirection: "row", alignItems: "center", gap: 6 },
  backLabel: { fontSize: 14, color: theme.colors.foreground, fontFamily: theme.fonts.sans },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  desc: { fontSize: 13, color: theme.colors.mutedForeground, lineHeight: 19, fontFamily: theme.fonts.sans },
  statusRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  addressBox: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.muted,
    borderRadius: 0,
    marginTop: 4,
  },
  addressText: { flex: 1 },
  copied: { fontSize: 12, color: theme.colors.success, fontFamily: theme.fonts.sans },
  errHint: { fontSize: 12, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  activeCard: {
    backgroundColor: theme.colors.success + "14",
    borderWidth: 1,
    borderColor: theme.colors.success,
    borderRadius: 0,
    padding: 14,
    gap: 4,
  },
  activeTitle: { fontSize: 15, fontWeight: "700", color: theme.colors.success, fontFamily: theme.fonts.sansBold },
});