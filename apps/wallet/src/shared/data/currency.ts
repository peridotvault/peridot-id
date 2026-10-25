// Display currency + CoinGecko rates for the All-Balance card.
// ponytail: localStorage on web, in-memory fallback on native (no new dep).
// Single simple/price call cached 60s; null on failure so the card degrades
// to fiat + native amounts instead of crashing.

export type Currency = "IDR" | "USD";

export const CURRENCIES: Currency[] = ["IDR", "USD"];
const KEY = "pid_currency";

let mem: Currency = "IDR";

export function getCurrency(): Currency {
  try {
    const raw =
      typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    if (raw === "IDR" || raw === "USD") {
      mem = raw;
      return raw;
    }
  } catch {
    /* private mode — fall through to memory */
  }
  return mem;
}

export function setCurrency(c: Currency): void {
  mem = c;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(KEY, c);
  } catch {
    /* non-fatal */
  }
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
