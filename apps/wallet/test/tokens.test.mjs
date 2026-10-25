// Token discovery (Phantom-style list): enriched mapping + zero-filter.
// calcTotal is route-private (inlined in pages/home/Home.tsx — cross-rail
// math no single feat owns), so only chain-pure shaping is unit-tested here.
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCoins, shortMint } from "../src/feat/chain/utils/assets.ts";

const USDC_DEV = "4zMMC6tc2RJf5zkCBqsqJ5mTcgnEHXUsdt8E3uBcps15";
const UNKNOWN = "11111111111111111111111111111112";

describe("buildCoins", () => {
  it("puts SOL first and hides zero-balance dust", () => {
    const coins = buildCoins(1_000_000_000, [
      { mint: UNKNOWN, amount: "0", decimals: 6, account: "a1" },
      { mint: USDC_DEV, amount: "2500000", decimals: 6, account: "a2", symbol: "USDC", name: "USD Coin" },
    ]);
    assert.equal(coins.length, 2);
    assert.equal(coins[0].symbol, "SOL");
    assert.equal(coins[1].symbol, "USDC");
    assert.equal(coins[1].name, "USD Coin");
  });

  it("falls back to short mint for unknown tokens", () => {
    const [, coin] = buildCoins(0, [{ mint: UNKNOWN, amount: "5", decimals: 0, account: "a1" }]);
    assert.equal(coin.symbol, shortMint(UNKNOWN));
    assert.equal(coin.name, shortMint(UNKNOWN));
    assert.equal(coin.image, undefined);
  });

  it("prefers enriched registry symbol", () => {    const [, coin] = buildCoins(0, [
      { mint: USDC_DEV, amount: "1", decimals: 6, account: "a2", symbol: "USDC", name: "USD Coin", image: "https://x/y.png" },
    ]);
    assert.equal(coin.symbol, "USDC");
    assert.equal(coin.image, "https://x/y.png");
  });

  it("keeps pinned zero-balance rows as entry points", () => {
    const coins = buildCoins(0, [
      { mint: USDC_DEV, amount: "0", decimals: 6, account: "", symbol: "USDC", name: "USD Coin", pinned: true },
    ]);
    assert.equal(coins.length, 2);
    assert.equal(coins[1].symbol, "USDC");
    assert.equal(coins[1].amount, "0");
  });
});
