import { useCallback, useEffect, useState } from "react";
import { Button, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  ChevronRight,
  Settings,
  Shield,
} from "lucide-react-native";
import type { Account, Authority, Profile, WalletTransaction } from "@peridotvault/pid-types";
import type { TokenBalance } from "@peridotvault/pid-solana";
import type { ActivationView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { SOLANA_NETWORK } from "../config";
import { theme, styles as s } from "../theme";

const LAMPORTS_PER_SOL = 1e9;

const KNOWN_MINTS: Record<string, string> = {
  "4zMMC6tc2RJf5zkCBqsqJ5mTcgnEHXUsdt8E3uBcps15": "USDC",
};

function fmtBalance(units: string, decimals: number): string {
  const n = Number(units) / 10 ** decimals;
  if (n === 0) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

function fmtActivityAmount(t: WalletTransaction): string {
  if (t.amount == null) return "";
  const value = Number(t.amount) / (t.asset === "SOL" ? LAMPORTS_PER_SOL : 1e6);
  const sign = t.direction === "in" ? "+" : t.direction === "out" ? "−" : "";
  return `${sign}${value.toLocaleString("en-US", { maximumFractionDigits: 3 })} ${t.asset === "SOL" ? "SOL" : t.asset}`;
}

function activityLabel(t: WalletTransaction): string {
  if (t.type === "DEPOSIT") return "Receive";
  if (t.type === "WITHDRAW") return "Send";
  if (t.type === "ACTIVATION") return "Activation";
  return "Transaction";
}

interface HomeScreenProps {
  goSend: () => void;
  goReceive: () => void;
  goSwap: () => void;
  goActivity: () => void;
  goActivityDetail: (tx: WalletTransaction) => void;
  goActivation: () => void;
  goSettings: () => void;
  onLogout: () => void;
}

export function HomeScreen({
  goSend,
  goReceive,
  goSwap,
  goActivity,
  goActivityDetail,
  goActivation,
  goSettings,
  onLogout,
}: HomeScreenProps) {
  const { peridot } = usePeridot();
  const [account, setAccount] = useState<Account | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [solLamports, setSolLamports] = useState<number>(0);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [activity, setActivity] = useState<WalletTransaction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      let acc = await peridot.wallet.me();
      if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
      if ("statusCode" in acc) {
        const detail = Array.isArray(acc.message) ? acc.message.join(" ") : acc.message;
        throw new Error(`Failed to create account (${acc.statusCode}${detail ? `: ${detail}` : ""})`);
      }
      const acct = acc as Account;
      setAccount(acct);

      try {
        const p = await peridot.profile.me();
        if (!("statusCode" in p)) setProfile(p as Profile);
      } catch {
        /* no profile */
      }
      try {
        setSolLamports(await peridot.wallet.getBalance());
      } catch {
        setSolLamports(0);
      }
      try {
        setTokens(await peridot.wallet.tokens());
      } catch {
        setTokens([]);
      }
      try {
        const creds = await peridot.passkey.list();
        setPasskeys(Array.isArray(creds) ? (creds as Authority[]) : []);
      } catch {
        setPasskeys([]);
      }
      try {
        const act = await peridot.wallet.activation(acct.id);
        if (!("statusCode" in act)) setActivation(act as ActivationView);
      } catch {
        setActivation(null);
      }
      try {
        const txs = await peridot.wallet.history();
        setActivity((Array.isArray(txs) ? txs : []).slice(0, 5));
      } catch {
        setActivity([]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  const smart = account?.chainAccounts?.find((c) => c.accountType === "smart_account");
  const solBalance = solLamports / LAMPORTS_PER_SOL;

  const coins: Coin[] = [
    { key: "sol", symbol: "SOL", amount: fmtBalance(String(solLamports), 9), raw: String(solLamports), decimals: 9 },
    ...tokens.map((t) => ({
      key: t.mint,
      symbol: KNOWN_MINTS[t.mint] ?? shortMint(t.mint),
      amount: fmtBalance(t.amount, t.decimals),
      raw: t.amount,
      decimals: t.decimals,
    })),
  ];

  const st = activation?.status;
  const activated = st === "active";
  const balanceColor = activated ? theme.colors.foreground : theme.colors.danger;
  const displayName = profile?.displayName ?? profile?.username ?? "Peridot ID";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <View style={styles.topRow}>
        <TouchableOpacity style={styles.profileChip} onPress={goSettings}>
          <View style={styles.profileAvatar}>
            <Text style={styles.profileInitial}>{displayName.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View>
            <Text style={styles.profileName}>{displayName}</Text>
            <Text style={styles.network}>Network · {SOLANA_NETWORK}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.iconBtn} onPress={goSettings} accessibilityLabel="Settings">
          <Settings size={18} color={theme.colors.foreground} />
        </TouchableOpacity>
      </View>

      <View style={styles.balanceBlock}>
        <Text style={[styles.balance, { color: balanceColor }]}>◎ {solBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })}</Text>
        <Text style={styles.balanceLabel}>Wallet balance</Text>
      </View>

      {!activated && !busy && (
        <TouchableOpacity style={styles.activateBadge} onPress={goActivation}>
          <View style={styles.activateDot} />
          <Text style={styles.activateBadgeText}>
            {st === "ready"
              ? "Account not active — activate to send"
              : st === "insufficient"
                ? "Account needs top-up to activate"
                : st === "activating"
                  ? "Activating account…"
                  : "Account not active — activate to send"}
          </Text>
          <ChevronRight size={14} color={theme.colors.mutedForeground} />
        </TouchableOpacity>
      )}

      <View style={styles.actions}>
        <ActionButton icon={ArrowUpRight} label="Send" onPress={goSend} disabled={!activated} />
        <ActionButton icon={ArrowDownLeft} label="Receive" onPress={goReceive} />
        <ActionButton icon={Coins} label="Swap" onPress={goSwap} />
      </View>

      {error && <Text style={s.error}>{error}</Text>}

      {!activated && !busy && <Text style={s.hint}>Send is available after your account is activated on-chain.</Text>}

      {activated && passkeys.length === 0 && !busy && (
        <TouchableOpacity style={styles.passkeyWarn} onPress={goSettings}>
          <Text style={styles.passkeyWarnText}>No passkey — add one in Security to authorize withdrawals.</Text>
        </TouchableOpacity>
      )}

      <View style={styles.securityRow}>
        <Shield size={16} color={theme.colors.mutedForeground} />
        <Text style={styles.securityText}>{passkeys.length} passkey{passkeys.length === 1 ? "" : "s"}</Text>
        <TouchableOpacity onPress={goSettings} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={styles.securityLink}>Manage</Text>
          <ChevronRight size={14} color={theme.colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionLabel}>Assets</Text>
      {coins.length === 0 && !busy && (
        <Text style={s.hint}>No assets yet — receive SOL to your address to get started.</Text>
      )}
      {coins.map((coin) => (
        <View key={coin.key} style={styles.coinRow}>
          <View style={styles.coinIcon}>
            <Coins size={18} color={theme.colors.foreground} />
          </View>
          <View style={styles.coinMeta}>
            <Text style={styles.coinSymbol}>{coin.symbol}</Text>
            {coin.symbol !== "SOL" && <Text style={styles.coinMint}>{coin.key.slice(0, 4)}…{coin.key.slice(-4)}</Text>}
          </View>
          <Text style={styles.coinAmount}>{coin.amount}</Text>
        </View>
      ))}

      {smart && (
        <View style={s.card}>
          <Text style={s.label}>PeridotID Address</Text>
          <Text selectable style={s.mono}>
            {smart.address.slice(0, 4)}…{smart.address.slice(-8)}
          </Text>
        </View>
      )}

      <View style={styles.sectionHead}>
        <Text style={styles.sectionLabel}>Recent Activity</Text>
        <TouchableOpacity onPress={goActivity} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={styles.viewAll}>View all</Text>
          <ChevronRight size={14} color={theme.colors.mutedForeground} />
        </TouchableOpacity>
      </View>
      {activity.length === 0 && !busy && <Text style={s.hint}>No activity yet.</Text>}
      {activity.map((t) => (
        <TouchableOpacity key={t.id} style={styles.activityRow} onPress={() => goActivityDetail(t)}>
          <View style={styles.activityMeta}>
            <Text style={styles.activityLabel}>{activityLabel(t)}</Text>
            <Text style={styles.activityDate}>{new Date(t.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</Text>
          </View>
          {t.amount != null && <Text style={styles.activityAmount}>{fmtActivityAmount(t)}</Text>}
        </TouchableOpacity>
      ))}

      <View style={styles.footer}>
        <Button title="Sign Out" onPress={onLogout} />
      </View>
    </ScrollView>
  );
}

function ActionButton({ icon: Icon, label, onPress, disabled }: { icon: typeof ArrowUpRight; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, disabled && styles.actionBtnDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled }}
    >
      <View style={styles.actionIcon}>
        <Icon size={20} color={disabled ? theme.colors.mutedForeground : theme.colors.foreground} />
      </View>
      <Text style={[styles.actionLabel, disabled && styles.actionLabelDisabled]}>{label}</Text>
    </TouchableOpacity>
  );
}

interface Coin {
  key: string;
  symbol: string;
  amount: string;
  raw: string;
  decimals: number;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  container: { padding: 24, gap: 14 },
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  profileChip: { flexDirection: "row", alignItems: "center", gap: 12 },
  profileAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  profileInitial: { fontSize: 18, fontWeight: "700", color: theme.colors.foreground, fontFamily: "serif" },
  profileName: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground },
  network: {
    fontSize: 11,
    color: theme.colors.mutedForeground,
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
  },
  balanceBlock: { gap: 4 },
  balance: { fontSize: 40, fontWeight: "700", fontFamily: "serif" },
  balanceLabel: { fontSize: 13, color: theme.colors.mutedForeground },
  actions: { flexDirection: "row", gap: 12 },
  actionBtn: {
    flex: 1,
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  actionBtnDisabled: { opacity: 0.4 },
  actionLabelDisabled: { opacity: 0.6 },
  actionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: { fontSize: 13, color: theme.colors.foreground, fontWeight: "500" },
  activateBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  activateDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.danger,
  },
  activateBadgeText: { fontSize: 12, color: theme.colors.mutedForeground, fontWeight: "500" },
  passkeyWarn: {
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    padding: 12,
  },
  passkeyWarnText: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center" },
  securityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 4,
  },
  securityText: { fontSize: 13, color: theme.colors.mutedForeground, flex: 1 },
  securityLink: { fontSize: 13, color: theme.colors.foreground, fontWeight: "500" },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  sectionLabel: {
    fontSize: 12,
    color: theme.colors.mutedForeground,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  viewAll: { fontSize: 13, color: theme.colors.foreground, fontWeight: "500" },
  coinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  coinIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  coinMeta: { flex: 1 },
  coinSymbol: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground },
  coinMint: { fontSize: 11, color: theme.colors.mutedForeground },
  coinAmount: { fontSize: 15, fontWeight: "500", color: theme.colors.foreground, fontFamily: "monospace" },
  activityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  activityMeta: { gap: 2 },
  activityLabel: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  activityDate: { fontSize: 11, color: theme.colors.mutedForeground },
  activityAmount: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground, fontFamily: "monospace" },
  footer: { marginTop: 16 },
});