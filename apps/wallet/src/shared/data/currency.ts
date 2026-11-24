// Display currency + CoinGecko rates for the All-Balance card.
// The preference itself is a Zustand store with persist over IndexedDB (Dexie
// `prefs` table): one async write path, no hand-rolled localStorage code.
// `hydrateCurrency()` runs once at boot so the first render already shows the
// stored choice. Rates: single simple/price call cached 60s; null on failure so
// the card degrades to fiat + native amounts instead of crashing.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { readPref, removePref, writePref } from "./db.ts";

export type Currency = "IDR" | "USD";

export const CURRENCIES: Currency[] = ["IDR", "USD"];

const useCurrencyStore = create<{ currency: Currency; set: (c: Currency) => void }>()(
  persist(
    (set) => ({ currency: "IDR", set: (currency) => set({ currency }) }),
    {
      name: "pid:currency",
      storage: createJSONStorage(() => ({
        getItem: (name) => readPref<string>(name),
        setItem: (name, value) => writePref(name, value),
        removeItem: (name) => removePref(name),
      })),
      // Anything but the two shipped values falls back to IDR.
      merge: (stored, current) => {
        const c = (stored as { currency?: unknown } | null)?.currency;
        return c === "IDR" || c === "USD" ? { ...current, currency: c } : current;
      },
    },
  ),
);

/** Load the stored preference before the first render (boot gate). */
export async function hydrateCurrency(): Promise<void> {
  await useCurrencyStore.persist.rehydrate();
}

export function getCurrency(): Currency {
  return useCurrencyStore.getState().currency;
}

export function setCurrency(c: Currency): void {
  useCurrencyStore.getState().set(c);
}

export interface Rates {
  solIdr: number;
  solUsd: number;
  /** IDR per 1 USD, derived from USDC-IDR (fallback when missing). */
  idrPerUsd: number;
  /** USDC/SPL-stablecoin unit prices for the breakdown total. */
  usdcIdr: number;
  usdcUsd: number;
}

let cached: { at: number; rates: Rates } | null = null;
let inflight: Promise<Rates | null> | null = null;

async function fetchFresh(): Promise<Rates | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana,usd-coin&vs_currencies=idr,usd",
    );
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, Record<string, number>>;
    const solIdr = Number(j?.solana?.idr);
    const solUsd = Number(j?.solana?.usd);
    const usdcIdr = Number(j?.["usd-coin"]?.idr);
    const usdcUsd = Number(j?.["usd-coin"]?.usd);
    if (!Number.isFinite(solIdr) || !Number.isFinite(solUsd)) return null;
    return {
      solIdr,
      solUsd,
      usdcIdr: Number.isFinite(usdcIdr) ? usdcIdr : 0,
      usdcUsd: Number.isFinite(usdcUsd) ? usdcUsd : 0,
      idrPerUsd: Number.isFinite(usdcIdr) && usdcIdr > 0 ? usdcIdr : 16000,
    };
  } catch {
    return null;
  }
}

export function getRates(): Promise<Rates | null> {
  if (cached && Date.now() - cached.at < 60_000) return Promise.resolve(cached.rates);
  if (inflight) return inflight;
  inflight = fetchFresh().then((rates) => {
    inflight = null;
    if (rates) cached = { at: Date.now(), rates };
    return rates;
  });
  return inflight;
}

/** Whole-IDR string → display in the selected currency. */
export function formatIdrWhole(balanceIdr: string, currency: Currency, rates: Rates | null): string {
  const idr = Number(balanceIdr);
  if (!Number.isFinite(idr)) return "—";
  if (currency === "IDR") {
    return `${idr.toLocaleString("id-ID", { maximumFractionDigits: 0 })} IDR`;
  }
  const perUsd = rates?.idrPerUsd ?? 16000;
  return `${(idr / perUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })} USD`;
}

/** Total portfolio value display. Inputs are already in target-currency major units. */
export function formatTotal(total: number, currency: Currency): string {
  if (!Number.isFinite(total)) return "—";
  return currency === "IDR"
    ? `${total.toLocaleString("id-ID", { maximumFractionDigits: 0 })} IDR`
    : `${total.toLocaleString("en-US", { maximumFractionDigits: 2 })} USD`;
}

/** Split total into symbol + integer + fraction for mixed-size display (always 2 decimals). */
export function formatTotalParts(total: number, currency: Currency): { prefix: string; int: string; frac: string } {
  if (!Number.isFinite(total)) return { prefix: "", int: "—", frac: "" };
  const parts = new Intl.NumberFormat(currency === "IDR" ? "id-ID" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).formatToParts(total);
  let int = "";
  let frac = "";
  let decimal = ".";
  for (const p of parts) {
    if (p.type === "integer" || p.type === "group" || p.type === "minusSign") int += p.value;
    else if (p.type === "fraction") frac = p.value;
    else if (p.type === "decimal") decimal = p.value;
  }
  return { prefix: currency === "IDR" ? "Rp" : "$", int, frac: `${decimal}${frac}` };
}
