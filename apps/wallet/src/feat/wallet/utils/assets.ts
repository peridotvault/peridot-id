import type { TokenBalance } from "@peridotvault/pid-solana";
import type { Currency, Rates } from "../../../shared/currency";

const KNOWN_MINTS: Record<string, string> = {
  "4zMMC6tc2RJf5zkCBqsqJ5mTcgnEHXUsdt8E3uBcps15": "USDC",
};

export interface Coin {
  key: string;
  symbol: string;
  amount: string;
  raw: string;
  decimals: number;
}

export function fmtBalance(units: string, decimals: number): string {
  const n = Number(units) / 10 ** decimals;
  if (n === 0) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export function buildCoins(solLamports: number, tokens: TokenBalance[]): Coin[] {
  return [
    { key: "sol", symbol: "SOL", amount: fmtBalance(String(solLamports), 9), raw: String(solLamports), decimals: 9 },
    ...tokens.map((t) => ({
      key: t.mint,
      symbol: KNOWN_MINTS[t.mint] ?? shortMint(t.mint),
      amount: fmtBalance(t.amount, t.decimals),
      raw: t.amount,
      decimals: t.decimals,
    })),
  ];
}

// All Balance = fiat IDR + crypto converted to the selected currency.
// Unknown SPL mints have no price — counted as 0 in the total, shown native.
export function calcTotal(input: {
  solLamports: number;
  tokens: TokenBalance[];
  balanceIdr: string | null;
  currency: Currency;
  rates: Rates | null;
}): number {
  const { solLamports, tokens, balanceIdr, currency, rates } = input;
  const unitValue = (symbol: string, raw: string, decimals: number): number => {
    if (!rates) return 0;
    const units = Number(raw) / 10 ** decimals;
    if (!Number.isFinite(units)) return 0;
    if (symbol === "SOL") return units * (currency === "IDR" ? rates.solIdr : rates.solUsd);
    if (symbol === "USDC") return units * (currency === "IDR" ? rates.usdcIdr : rates.usdcUsd);
    return 0;
  };
  const fiatValue =
    balanceIdr === null || !Number.isFinite(Number(balanceIdr))
      ? 0
      : currency === "IDR"
        ? Number(balanceIdr)
        : Number(balanceIdr) / (rates?.idrPerUsd ?? 16000);
  const tokensValue = tokens.reduce(
    (sum, t) => sum + unitValue(KNOWN_MINTS[t.mint] ?? "", t.amount, t.decimals),
    0,
  );
  return fiatValue + unitValue("SOL", String(solLamports), 9) + tokensValue;
}
