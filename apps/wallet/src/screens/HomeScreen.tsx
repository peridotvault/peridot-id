import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  Coins,
  ChevronRight,
  Link2,
} from "../icons";
import type { Authority, Identity, Profile } from "@peridotvault/pid-types";
import type { TokenBalance, NftItem } from "@peridotvault/pid-solana";
import type { ActivationView } from "@peridotvault/pid-sdk-js";
import { usePeridot } from "../AppContext";
import { theme, styles as s } from "../theme";
import { UIButton } from "../components/UIButton";
import { ensureSubAccount } from "../fiat-ensure";

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

interface HomeScreenProps {
  goSend: () => void;
  goReceive: () => void;
  goSwap: () => void;
  goBuy: () => void;
  goActivation: () => void;
  goPasskeys: () => void;
  goAppConnections: () => void;
}

export function HomeScreen({
  goSend,
  goReceive,
  goSwap,
  goBuy,
  goActivation,
  goPasskeys,
  goAppConnections,
}: HomeScreenProps) {
  const { peridot } = usePeridot();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [solLamports, setSolLamports] = useState<number>(0);
  // null = failed load (error shown separately). "0" means no wallet yet
  // (web3-only user) or a real zero from the API.
  const [idrBalance, setIdrBalance] = useState<string | null>(null);
  const [idrError, setIdrError] = useState<string | null>(null);
  // Fiat still arriving at DOKU (Pending), shown read-only so a fresh
  // deposit doesn't look lost. Never spendable from here — Saldo above is
  // the only usable number; null hides the line entirely.
  const [idrPending, setIdrPending] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [nfts, setNfts] = useState<NftItem[]>([]);
  const [assetTab, setAssetTab] = useState<"tokens" | "items">("tokens");
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [activation, setActivation] = useState<ActivationView | null>(null);
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

      try {
        const p = await peridot.profile.me();
        if (!("statusCode" in p)) setProfile(p as Profile);
      } catch {
        /* no profile */
      }
      try {
        const me = await peridot.identity.me();
        if (!("statusCode" in me)) setPid((me as Identity).pid);
      } catch {
        /* no identity */
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
        setNfts(await peridot.wallet.nfts());
      } catch {
        setNfts([]);
      }
      try {
        // Saldo = live DOKU Unified Ledger (POINT) balance. Pending fiat is
        // shown read-only below so arriving deposits are visible; it is
        // never spendable and this screen never shows ledger internals.
        const bal = await peridot.fiat.balance();
        setIdrBalance(bal.pointsAvailableIdr);
        setIdrPending(bal.pendingIdr !== "0" ? bal.pendingIdr : null);
        setIdrError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not registered/i.test(msg)) {
          // No sub-account yet (web3-only user) — IDR is simply 0, not an error.
          setIdrBalance("0");
          setIdrPending(null);
          setIdrError(null);
        } else if (/is creating|is failed/i.test(msg)) {
          // Dead creating/failed row (missed provisioning) — heal once, then read.
          try {
            await ensureSubAccount(peridot);
            const bal = await peridot.fiat.balance();
            setIdrBalance(bal.pointsAvailableIdr);
            setIdrPending(bal.pendingIdr !== "0" ? bal.pendingIdr : null);
            setIdrError(null);
          } catch (e2) {
            setIdrBalance(null);
            setIdrPending(null);
            setIdrError(e2 instanceof Error ? e2.message : String(e2));
          }
        } else {
          setIdrBalance(null);
          setIdrPending(null);
          // Distinct causes, distinct guidance: 401 = session gone, 404 = stale
          // API without sub-account routes, anything else = DOKU/gateway verbatim.
          setIdrError(
            /401|Unauthorized/i.test(msg)
              ? "Session expired — log in again."
              : /404|Not Found|Cannot GET|Cannot POST/i.test(msg)
                ? "API server is outdated — restart it."
                : msg,
          );
        }
      }
      try {
        const creds = await peridot.passkey.list();
        setPasskeys(Array.isArray(creds) ? (creds as Authority[]) : []);
      } catch {
        setPasskeys([]);
      }
      try {
        const act = await peridot.wallet.activation();
        if (!("statusCode" in act)) setActivation(act as ActivationView);
      } catch {
        setActivation(null);
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

  const fiatAmount = idrBalance === null ? null : `Rp${Number(idrBalance).toLocaleString("id-ID")}`;

  const st = activation?.status;
  const activated = st === "active";
  const balanceColor = activated ? theme.colors.foreground : theme.colors.danger;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <View style={styles.topRow}>
        <View style={styles.identity}>
          <Text style={styles.pid}>{pid ?? "…"}</Text>
          {profile?.displayName ? <Text style={styles.displayName}>{profile.displayName}</Text> : null}
        </View>
        <TouchableOpacity style={styles.connBtn} onPress={goAppConnections} accessibilityLabel="App connections">
          <Link2 size={18} color={theme.colors.foreground} />
        </TouchableOpacity>
      </View>

      <View style={styles.balanceBlock}>
        <Text style={[styles.balance, { color: balanceColor }]}>$ {solBalance.toLocaleString("en-US", { maximumFractionDigits: 4 })}</Text>
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
        <ActionButton icon={Banknote} label="Buy" onPress={goBuy} />
      </View>

      {error && <Text style={s.error}>{error}</Text>}

      {activated && passkeys.length === 0 && !busy && (
        <TouchableOpacity style={styles.passkeyWarn} onPress={goPasskeys}>
          <Text style={styles.passkeyWarnText}>No passkey — add one in Security to authorize withdrawals.</Text>
        </TouchableOpacity>
      )}

      <View style={s.card}>
        <Text style={styles.fiatLabel}>Saldo</Text>
        {idrError ? (
          <>
            <Text style={s.error}>{idrError}</Text>
            <UIButton title="Retry" onPress={load} />
          </>
        ) : (
          <Text style={styles.fiatAmount}>{busy && fiatAmount === null ? "…" : (fiatAmount ?? "—")}</Text>
        )}
        {!idrError && idrPending && (
          <Text style={s.hint}>Arriving: Rp{Number(idrPending).toLocaleString("id-ID")} — added to Saldo once your payment is confirmed.</Text>
        )}
      </View>

      <View style={styles.plainTabs}>
        <TabButton label="Tokens" active={assetTab === "tokens"} onPress={() => setAssetTab("tokens")} />
        <TabButton label="Items" active={assetTab === "items"} onPress={() => setAssetTab("items")} />
      </View>
      {assetTab === "tokens" ? (
        <>
          {coins.length === 0 && !busy && (
            <Text style={s.hint}>No assets yet — receive SOL to your address to get started.</Text>
          )}
          {coins.map((coin) => (
            <View key={coin.key} style={styles.coinRow}>
              <View style={styles.coinMeta}>
                <Text style={styles.coinSymbol}>{coin.symbol}</Text>
                {coin.symbol !== "SOL" && <Text style={styles.coinMint}>{coin.key.slice(0, 4)}…{coin.key.slice(-4)}</Text>}
              </View>
              <Text style={styles.coinAmount}>{coin.amount}</Text>
            </View>
          ))}
        </>
      ) : (
        <>
          {nfts.length === 0 && !busy && (
            <Text style={s.hint}>No items yet — SPL collectibles in this wallet appear here.</Text>
          )}
          {nfts.map((nft) => (
            <View key={nft.mint} style={styles.coinRow}>
              <View style={styles.coinMeta}>
                <Text style={styles.coinSymbol}>{nft.name ?? "Unnamed item"}</Text>
                <Text style={styles.coinMint}>{nft.mint.slice(0, 4)}…{nft.mint.slice(-4)}</Text>
              </View>
            </View>
          ))}
          {nfts.length > 0 && (
            <Text style={s.hint}>SPL collectibles only — Token-2022 and compressed NFTs need a DAS RPC.</Text>
          )}
        </>
      )}
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

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} accessibilityState={{ selected: active }}>
      <Text style={[styles.plainTabLabel, active && styles.plainTabLabelActive]}>{label}</Text>
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
  identity: { flex: 1, gap: 4 },
  pid: { fontSize: 20, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  displayName: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  connBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  balanceBlock: { gap: 4 },
  balance: { fontSize: 40, fontWeight: "400", fontFamily: theme.fonts.serif },
  actions: { flexDirection: "row", gap: 12 },
  actionBtn: {
    flex: 1,
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 0,
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
  actionLabel: { fontSize: 13, color: theme.colors.foreground, fontWeight: "500", fontFamily: theme.fonts.sansMedium },
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
  activateBadgeText: { fontSize: 12, color: theme.colors.mutedForeground, fontWeight: "500", fontFamily: theme.fonts.sansMedium },
  passkeyWarn: {
    backgroundColor: theme.colors.muted,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 0,
    padding: 12,
  },
  passkeyWarnText: { color: theme.colors.mutedForeground, fontSize: 13, textAlign: "center", fontFamily: theme.fonts.sans },
  coinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  coinMeta: { flex: 1 },
  coinSymbol: { fontSize: 15, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  coinMint: { fontSize: 11, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  fiatLabel: { fontSize: 13, color: theme.colors.mutedForeground, fontFamily: theme.fonts.sans },
  fiatAmount: { fontSize: 24, fontWeight: "600", color: theme.colors.foreground, fontFamily: theme.fonts.sansSemiBold },
  coinAmount: { fontSize: 15, fontWeight: "500", color: theme.colors.foreground, fontFamily: theme.fonts.mono },
  plainTabs: { flexDirection: "row", gap: 20, paddingVertical: 6 },
  plainTabLabel: { fontSize: 14, fontWeight: "500", color: theme.colors.mutedForeground, fontFamily: theme.fonts.sansMedium, paddingBottom: 4 },
  plainTabLabelActive: { color: theme.colors.foreground, borderBottomWidth: 1, borderBottomColor: theme.colors.foreground },
});