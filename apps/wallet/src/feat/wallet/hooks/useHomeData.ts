import { useCallback, useEffect, useState } from "react";
import type { Authority, Identity, Profile } from "@peridotvault/pid-types";
import type { TokenBalance, NftItem } from "@peridotvault/pid-solana";
import type { ActivationView, PeridotClient } from "@peridotvault/pid-sdk-js";
import { getCurrency, getRates, type Currency, type Rates } from "../../../shared/currency";
import { cachedRead, clearApiCache } from "../../../shared/api-cache";
import { endNetworkTransition, subscribeNetworkMode } from "../../../shared/network-mode";

// Dashboard data: identity, chain assets, fiat ledger balance, activation.
// Currency pref re-reads on every load (Settings writes localStorage; the
// screen remounts when navigating back, so no subscription needed).
// Network mode re-fetches via the store subscription (ANT-15 req 3): every
// fetch is selection-scoped server-side, so a reload is all it takes to keep
// balances separate (never merged client-side).
//
// Request budget (per-IP 100/min): slow-changing reads go through cachedRead
// (see shared/api-cache.ts) and NTFs load only when the Items tab is opened,
// so revisiting Home costs 3 requests (balance, tokens, fiat) instead of 9.
export function useHomeData(peridot: PeridotClient) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [solLamports, setSolLamports] = useState<number>(0);
  // Balance = the fiat ledger. null = failed load (error shown separately).
  const [balanceIdr, setBalanceIdr] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [nfts, setNfts] = useState<NftItem[]>([]);
  const [nftsLoaded, setNftsLoaded] = useState(false);
  const [assetTab, setAssetTab] = useState<"tokens" | "items">("tokens");
  const [passkeys, setPasskeys] = useState<Authority[]>([]);
  const [activation, setActivation] = useState<ActivationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<Currency>(getCurrency);
  const [rates, setRates] = useState<Rates | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    setCurrency(getCurrency());
    // Non-fatal: without prices the card degrades to fiat + native amounts.
    getRates().then(setRates).catch(() => setRates(null));
    try {
      let acc = await cachedRead("wallet.me", { ttlMs: 10_000, tier: "session" }, () => peridot.wallet.me());
      if ("statusCode" in acc) acc = await peridot.wallet.createAccount();
      if ("statusCode" in acc) {
        const detail = Array.isArray(acc.message) ? acc.message.join(" ") : acc.message;
        throw new Error(`Failed to create account (${acc.statusCode}${detail ? `: ${detail}` : ""})`);
      }

      // Independent reads, one round trip instead of seven serial awaits.
      const [p, me, lamports, tok, fiat, creds, act] = await Promise.allSettled([
        cachedRead("profile.me", { ttlMs: 60_000, tier: "session" }, () => peridot.profile.me()),
        cachedRead("identity.me", { ttlMs: 60_000, tier: "session" }, () => peridot.identity.me()),
        cachedRead("wallet.balance", { ttlMs: 10_000 }, () => peridot.wallet.getBalance()),
        cachedRead("wallet.tokens", { ttlMs: 10_000 }, () => peridot.wallet.tokens()),
        cachedRead("fiat.balance", { ttlMs: 10_000 }, () => peridot.fiat.balance()),
        cachedRead("passkey.list", { ttlMs: 60_000, tier: "session" }, () => peridot.passkey.list()),
        cachedRead("wallet.activation", { ttlMs: 60_000, tier: "session" }, () => peridot.wallet.activation()),
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
      if (act.status === "fulfilled" && !("statusCode" in act.value)) setActivation(act.value as ActivationView);
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
  useEffect(() => {
    if (assetTab !== "items" || nftsLoaded) return;
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
  // selection-scoped server-side, so drop them first.
  useEffect(() => {
    return subscribeNetworkMode(() => {
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
    activated: st === "active",
  };
}
