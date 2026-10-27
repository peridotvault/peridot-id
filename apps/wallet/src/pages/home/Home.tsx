import { useCallback, useEffect, useState } from "react";
import type { ApiError, Authority, Identity, Profile, ChainAccount } from "@peridotvault/pid-types";
import type { NftItem, TokenBalance, TokenInfo } from "@peridotvault/pid-solana";
import type { ActivationView, PeridotClient } from "@peridotvault/pid-sdk-js";
import { ScrollArea } from "../../shared/components/ui/ScrollArea";
import { Pressable } from "../../shared/components/ui/Pressable";
import { BottomSheet } from "../../shared/components/ui/BottomSheet";
import { UIButton } from "../../shared/components/ui/UIButton";
import { ArrowDownLeft, ArrowUpRight, Banknote, Coins, LayoutGrid } from "../../shared/components/icons";
import { usePeridot } from "../../shared/app/AppContext";
import { styles as s } from "../../shared/styles/theme";
import { SectionTitle } from "../../shared/components/ui/SectionTitle";
import { useSelectedChains } from "../../shared/hooks/useSelectedChains";
import {
  formatTotalParts,
  getCurrency,
  getRates,
  type Currency,
  type Rates,
} from "../../shared/data/currency";
import { cachedRead, clearApiCache } from "../../shared/data/apiCache";
import { endNetworkTransition, subscribeNetworkMode } from "../../shared/data/networkMode";
import {
  filterChainAccountsForSelection,
  getSelection,
  isSolanaSelected,
  subscribeSelectedChains,
} from "../../shared/data/selectedChains";
import { buildCoins } from "../../feat/chain/utils/coins";
import { FiatSection } from "../../feat/fiat/components/FiatSection";
import { AssetSection } from "../../feat/chain/components/AssetSection";

interface HomeProps {
  goSend: () => void;
  goReceive: () => void;
  goSwap: () => void;
  goBuy: () => void;
  goTransfer: () => void;
  goRupiah: () => void;
  goPasskeys: () => void;
  goSettings: () => void;
}

export function Home({
  goSend,
  goReceive,
  goSwap,
  goBuy,
  goTransfer,
  goRupiah,
  goPasskeys,
  goSettings,
}: HomeProps) {
  const { peridot } = usePeridot();
  const d = useHomeData(peridot);
  // ANT-625 FR2: read-only selection chip (no toggle on Home — Settings is
  // the single place). Links to the Chains group in Settings.
  const sel = useSelectedChains();
  const [choice, setChoice] = useState(false);
  const coins = buildCoins(d.solLamports, d.tokens);
  const totalValue = calcTotal({
    solLamports: d.solLamports,
    tokens: d.tokens,
    balanceIdr: d.balanceIdr,
    currency: d.currency,
    rates: d.rates,
  });

  return (
    <ScrollArea className="flex-1 bg-background" contentContainerStyle={{ padding: 24, gap: 14 }}>
      <Pressable onPress={goSettings} accessibilityRole="link" accessibilityLabel={`Chains: ${sel.label}. Change in Settings.`}>
        <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-2 self-start border border-border bg-surface px-2.5 py-1.5">
          <LayoutGrid size={14} className="text-muted-foreground" />
          <span className="font-sans text-xs font-medium text-muted-foreground">{sel.label}</span>
        </div>
      </Pressable>
      <TotalBalanceSection
        currency={d.currency}
        totalValue={totalValue}
        loading={d.busy && d.balanceIdr === null}
      />
      <QuickActions onSend={() => setChoice(true)} onReceive={goReceive} onSwap={goSwap} onBuy={goBuy} />
      <FiatSection
        balanceIdr={d.balanceIdr}
        balanceError={d.balanceError}
        busy={d.busy}
        onRetry={d.load}
        onOpen={goRupiah}
      />

      <SendChoiceModal
        visible={choice}
        onPickOnChain={() => {
          setChoice(false);
          goSend();
        }}
        onPickIdr={() => {
          setChoice(false);
          goTransfer();
        }}
        onClose={() => setChoice(false)}
      />

      {d.error && <p role="alert" style={s.error}>{d.error}</p>}

      {d.activated && d.passkeys.length === 0 && !d.busy && (
        <Pressable onPress={goPasskeys} accessibilityLabel="Add a passkey in Security">
          <div className="flex flex-col border border-border bg-muted p-3">
            <span className="text-center font-sans text-sm text-muted-foreground">No passkey — add one in Security to authorize withdrawals.</span>
          </div>
        </Pressable>
      )}

      {/* ANT-625 FR6: the selection has no smart-account row — defined empty
          state, never an infinite spinner (load() always settles; the
          signing-block failsafe in the store is the ceiling, not the path). */}
      {d.emptySelection && !d.busy ? (
        <div className="flex flex-col gap-2 border border-border bg-surface p-3.5">
          <span className="font-sans text-sm font-semibold text-foreground">No {sel.label} account yet</span>
          <span className="font-sans text-sm leading-5 text-muted-foreground">
            This selection has no smart-account row — receive address below to fund it.
          </span>
          <Pressable onPress={goReceive} accessibilityLabel="Show receive addresses">
            <div style={{ flexDirection: "row" }} className="flex flex-col items-center gap-1 border border-foreground px-2.5 py-1.5">
              <span className="font-sans text-sm font-medium text-foreground">Show receive addresses</span>
            </div>
          </Pressable>
        </div>
      ) : (
        <AssetSection tab={d.assetTab} onTabChange={d.setAssetTab} coins={coins} nfts={d.nfts} busy={d.busy} />
      )}
    </ScrollArea>
  );
}

// Dashboard data: identity, chain assets, fiat ledger balance, activation.
// Wraps 5 SDK namespaces, so no single feat can own it — route-private hook.
// Currency pref re-reads on every load (Settings writes localStorage; the
// screen remounts when navigating back, so no subscription needed).
// Network mode re-fetches via the store subscription (ANT-15 req 3): every
// fetch is selection-scoped server-side, so a reload is all it takes to keep
// balances separate (never merged client-side).
//
// Request budget (per-IP 100/min): slow-changing reads go through cachedRead
// (see shared/apiCache.ts) and NTFs load only when the Items tab is opened,
// so revisiting Home costs 3 requests (balance, tokens, fiat) instead of 9.
function useHomeData(peridot: PeridotClient) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [solLamports, setSolLamports] = useState<number>(0);
  // Balance = the fiat ledger. null = failed load (error shown separately).
  const [balanceIdr, setBalanceIdr] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [nfts, setNfts] = useState<NftItem[]>([]);
  const [nftsLoaded, setNftsLoaded] = useState(false);
  const [assetTab, setAssetTab] = useState<"tokens" | "items">("tokens");
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<Currency>(getCurrency);
  const [rates, setRates] = useState<Rates | null>(null);
  // ANT-625 FR6: custom selection with no smart-account row in the selected
  // set — the screen renders the defined empty state instead of asset lists.
  const [emptySelection, setEmptySelection] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    setEmptySelection(false);
    setCurrency(getCurrency());
    // Non-fatal: without prices the card degrades to fiat + native amounts.
    getRates().then(setRates).catch(() => setRates(null));
    // ANT-625 FR3/FR4: read the selection synchronously before the first
    // fetch; Solana reads run only when Solana is selected (strict — no
    // unselected request fires, mode:all stays byte-identical to today).
    const sel = getSelection();
    const solanaOn = isSolanaSelected(sel);
    try {
      let acc = await cachedRead("wallet.me", { ttlMs: 10_000, tier: "session" }, () => peridot.wallet.me());
      if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
      if ("statusCode" in acc) {
        const detail = Array.isArray(acc.message) ? acc.message.join(" ") : acc.message;
        throw new Error(`Failed to create account (${acc.statusCode}${detail ? `: ${detail}` : ""})`);
      }
      const selectedRows = filterChainAccountsForSelection(acc as ChainAccount[], sel);
      setEmptySelection(
        sel.mode === "custom" && !selectedRows.some((c) => c.accountType === "smart_account"),
      );

      // Independent reads, one round trip instead of seven serial awaits.
      // Solana reads run only when Solana is selected (strict); the
      // explicitly-typed fallbacks keep the allSettled tuple inference
      // intact when the RPC is skipped.
      const balanceP: Promise<number> = solanaOn
        ? cachedRead("wallet.balance", { ttlMs: 10_000 }, () => peridot.wallet.getBalance())
        : Promise.resolve(0);
      const tokensP: Promise<unknown> = solanaOn
        ? cachedRead("wallet.tokens", { ttlMs: 10_000 }, () =>
            peridot.wallet.tokensEnriched().catch(() => peridot.wallet.tokens()),
          )
        : Promise.resolve([]);
      const activationP: Promise<unknown> = solanaOn
        ? cachedRead("wallet.activation", { ttlMs: 60_000, tier: "session" }, () => peridot.wallet.activation())
        : Promise.resolve(null);
      const [p, me, lamports, tok, fiat, creds, act] = await Promise.allSettled([
        cachedRead("profile.me", { ttlMs: 60_000, tier: "session" }, () => peridot.profile.me()),
        cachedRead("identity.me", { ttlMs: 60_000, tier: "session" }, () => peridot.identity.me()),
        balanceP,
        tokensP,
        cachedRead("fiat.balance", { ttlMs: 10_000 }, () => peridot.fiat.balance()),
        cachedRead("passkey.list", { ttlMs: 60_000, tier: "session" }, () => peridot.passkey.list()),
        activationP,
      ]);

      if (p.status === "fulfilled" && !("statusCode" in p.value)) setProfile(p.value as Profile);
      if (me.status === "fulfilled" && !("statusCode" in me.value)) setPid((me.value as Identity).pid);

      setSolLamports(lamports.status === "fulfilled" ? lamports.value : 0);
      setTokens(tok.status === "fulfilled" && Array.isArray(tok.value) ? tok.value : []);

      // Balance = the fiat ledger. Replay stays server-side; the user sees one
      // usable number. No DOKU sub-account required.
      if (fiat.status === "fulfilled" && !("statusCode" in fiat.value)) {
        setBalanceIdr(fiat.value.balanceIdr);
        setBalanceError(null);
      } else {
        const msg =
          fiat.status === "rejected"
            ? fiat.reason instanceof Error
              ? fiat.reason.message
              : String(fiat.reason)
            : "Balance is temporarily unavailable.";
        setBalanceIdr(null);
        setBalanceError(
          /401|Unauthorized/i.test(msg)
            ? "Session expired — log in again."
            : /503|disabled|frozen|unavailable/i.test(msg)
              ? "Balance is temporarily unavailable."
              : msg,
        );
      }

      setPasskeys(creds.status === "fulfilled" && Array.isArray(creds.value) ? (creds.value as Authority[]) : []);
      // Strict: with Solana unselected the activation view is cleared, never
      // fetched (assertChainEcho paths in withdraw/execute/activate keep
      // working untouched — the echo still asserts on 2xx when Solana runs).
      if (!solanaOn) {
        setActivation(null);
      } else if (act.status === "fulfilled") {
        const v = act.value as ActivationView | ApiError | null;
        if (v && typeof v === "object" && !("statusCode" in v)) setActivation(v);
      }
      // Lazy: NTFs come from the Items tab, so don't spend a request here.
      setNfts([]);
      setNftsLoaded(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [peridot]);

  useEffect(() => {
    load();
  }, [load]);

  // NTFs are fetched the first time the Items tab is opened (30s memo).
  // Strict: skipped entirely while Solana is unselected.
  useEffect(() => {
    if (assetTab !== "items" || nftsLoaded) return;
    if (!isSolanaSelected(getSelection())) {
      setNfts([]);
      setNftsLoaded(true);
      return;
    }
    let alive = true;
    cachedRead("wallet.nfts", { ttlMs: 60_000, tier: "session" }, () => peridot.wallet.nfts())
      .then((n) => {
        if (alive) setNfts(Array.isArray(n) ? n : []);
      })
      .catch(() => {
        if (alive) setNfts([]);
      })
      .finally(() => {
        if (alive) setNftsLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [assetTab, nftsLoaded, peridot]);

  // Re-fetch balances/assets on network switch, then release the signing
  // block. Idempotent — a no-op when no switch is in flight. Cached reads are
  // selection-scoped server-side, so drop them first. A selection switch
  // does the same via the selection store (strict client filtering).
  useEffect(() => {
    return subscribeNetworkMode(() => {
      clearApiCache();
      load().then(endNetworkTransition, endNetworkTransition);
    });
  }, [load]);

  useEffect(() => {
    return subscribeSelectedChains(() => {
      clearApiCache();
      load().then(endNetworkTransition, endNetworkTransition);
    });
  }, [load]);

  const st = activation?.status;
  return {
    profile,
    pid,
    solLamports,
    balanceIdr,
    balanceError,
    tokens,
    nfts,
    assetTab,
    setAssetTab,
    passkeys,
    busy,
    error,
    currency,
    rates,
    load,
    emptySelection,
    activated: st === "active",
  };
}

// Priced assets: [IDR rates field, USD rates field]. Unknown SPL mints have
// no price — counted as 0 in the total, shown native. New priced assets
// extend the table, not the branch.
const RATE_FIELD: Record<string, [keyof Rates, keyof Rates]> = {
  SOL: ["solIdr", "solUsd"],
  USDC: ["usdcIdr", "usdcUsd"],
};
// Cross-rail math (fiat + chain + FX): no single feat owns it — route-private.
function calcTotal(input: {
  solLamports: number;
  tokens: (TokenBalance & Partial<TokenInfo>)[];
  balanceIdr: string | null;
  currency: Currency;
  rates: Rates | null;
}): number {
  const { solLamports, tokens, balanceIdr, currency, rates } = input;
  const unitValue = (symbol: string, raw: string, decimals: number): number => {
    if (!rates) return 0;
    const units = Number(raw) / 10 ** decimals;
    if (!Number.isFinite(units)) return 0;
    const fields = RATE_FIELD[symbol];
    if (!fields) return 0;
    return units * rates[currency === "IDR" ? fields[0] : fields[1]];
  };
  const fiatValue =
    balanceIdr === null || !Number.isFinite(Number(balanceIdr))
      ? 0
      : currency === "IDR"
        ? Number(balanceIdr)
        : Number(balanceIdr) / (rates?.idrPerUsd ?? 16000);
  const tokensValue = tokens.reduce(
    (sum, t) => sum + unitValue(t.symbol ?? "", t.amount, t.decimals),
    0,
  );
  return fiatValue + unitValue("SOL", String(solLamports), 9) + tokensValue;
}

// New top section: portfolio total (fiat + crypto). Reuses the same
// calcTotal value as the card — no new fetch, no new logic. Integer leg is
// 5xl, the 2-decimal leg rides smaller + muted on the same baseline.
function TotalBalanceSection({
  currency,
  totalValue,
  loading,
}: {
  currency: Currency;
  totalValue: number;
  loading: boolean;
}) {
  const { prefix, int, frac } = formatTotalParts(totalValue, currency);
  return (
    <div className="flex flex-col gap-1 px-1">
      <SectionTitle as="h1">Total Balance</SectionTitle>
      {loading ? (
        <span
          className="font-serif text-5xl text-foreground"
          role="status"
          aria-label="Loading total balance"
        >
          …
        </span>
      ) : (
        <div style={{ flexDirection: "row" }} className="flex flex-col items-baseline" aria-label={`${prefix}${int}${frac}`}>
          <span className="font-serif text-5xl text-foreground">{prefix}{int}</span>
          <span className="font-serif text-4xl text-muted-foreground">{frac}</span>
        </div>
      )}
    </div>
  );
}

function QuickActions({
  onSend,
  onReceive,
  onSwap,
  onBuy,
}: {
  onSend: () => void;
  onReceive: () => void;
  onSwap: () => void;
  onBuy: () => void;
}) {
  return (
    <div style={{ flexDirection: "row" }} className="flex flex-col gap-3">
      <ActionButton icon={ArrowUpRight} label="Send" onPress={onSend} />
      <ActionButton icon={ArrowDownLeft} label="Receive" onPress={onReceive} />
      <ActionButton icon={Coins} label="Swap" onPress={onSwap} />
      <ActionButton icon={Banknote} label="Buy" onPress={onBuy} />
    </div>
  );
}

function ActionButton({ icon: Icon, label, onPress, disabled }: { icon: typeof ArrowUpRight; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled: !!disabled }}
      className="flex-1"
    >
      <div className={`flex flex-col w-full items-center gap-2 border border-border bg-surface py-3 ${disabled ? "opacity-40" : ""}`}>
        <div className="flex flex-col h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Icon size={20} className={disabled ? "text-muted-foreground" : "text-foreground"} />
        </div>
        <span className={`font-sans text-sm font-medium text-foreground ${disabled ? "opacity-60" : ""}`}>{label}</span>
      </div>
    </Pressable>
  );
}

// Send entry point: one button opens this chooser instead of routing direct.
// On-chain sends need no separate setup step — a first send sets up the
// account automatically inside the send flow (ANT-731 WS4); IDR (fiat
// ledger) never touches the chain at all.
function SendChoiceModal({
  visible,
  onPickOnChain,
  onPickIdr,
  onClose,
}: {
  visible: boolean;
  onPickOnChain: () => void;
  onPickIdr: () => void;
  onClose: () => void;
}) {
  return (
    <BottomSheet visible={visible} title="Send" onClose={onClose} scrimLabel="Close send options">
      <p style={s.hint}>Choose where to send from.</p>
      <UIButton
        title="Send On-Chain"
        note="To Solana address"
        icon={<ArrowUpRight size={16} className="text-foreground" />}
        onPress={onPickOnChain}
      />
      <UIButton
        title="Send IDR"
        note="To xxx@pid"
        icon={<Banknote size={16} className="text-foreground" />}
        onPress={onPickIdr}
      />
      <UIButton title="Cancel" onPress={onClose} />
    </BottomSheet>
  );
}
