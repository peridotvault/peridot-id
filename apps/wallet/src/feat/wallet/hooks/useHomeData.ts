import { useCallback, useEffect, useState } from "react";
import type { Authority, Identity, Profile } from "@peridotvault/pid-types";
import type { TokenBalance, NftItem } from "@peridotvault/pid-solana";
import type { ActivationView, PeridotClient } from "@peridotvault/pid-sdk-js";
import { getCurrency, getRates, type Currency, type Rates } from "../../../shared/currency";

// Dashboard data: identity, chain assets, fiat ledger balance, activation.
// Currency pref re-reads on every load (Settings writes localStorage; the
// screen remounts when navigating back, so no subscription needed).
export function useHomeData(peridot: PeridotClient) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [solLamports, setSolLamports] = useState<number>(0);
  // Balance = the fiat ledger. null = failed load (error shown separately).
  const [balanceIdr, setBalanceIdr] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [nfts, setNfts] = useState<NftItem[]>([]);
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
        // Balance = the fiat ledger. Replay stays server-side; the user sees one
        // usable number. No DOKU sub-account required.
        const bal = await peridot.fiat.balance();
        setBalanceIdr(bal.balanceIdr);
        setBalanceError(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBalanceIdr(null);
        setBalanceError(
          /401|Unauthorized/i.test(msg)
            ? "Session expired — log in again."
            : /503|disabled|frozen|unavailable/i.test(msg)
              ? "Balance is temporarily unavailable."
              : msg,
        );
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
