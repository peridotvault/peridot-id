import type { TokenBalance, TokenInfo } from "@peridotvault/pid-solana";

export interface Coin {
  key: string;
  symbol: string;
  name: string;
  image?: string;
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

export function buildCoins(solLamports: number, tokens: (TokenBalance & Partial<TokenInfo>)[]): Coin[] {
  return [
    { key: "sol", symbol: "SOL", name: "Solana", amount: fmtBalance(String(solLamports), 9), raw: String(solLamports), decimals: 9 },
    // Phantom hides empty token accounts — zero-balance rows are dust, not assets.
    // Exception: registry-pinned rows (e.g. USDC) always render as entry points.
    ...tokens
      .filter((t) => t.amount !== "0" || t.pinned)
      .map((t) => {
        const symbol = t.symbol ?? shortMint(t.mint);
        return {
          key: t.mint,
          symbol,
          name: t.name ?? symbol,
          image: t.image,
          amount: fmtBalance(t.amount, t.decimals),
          raw: t.amount,
          decimals: t.decimals,
        };
      }),
  ];
}
