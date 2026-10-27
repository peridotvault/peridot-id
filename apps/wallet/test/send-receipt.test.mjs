// ANT-748: post-send receipt renders settled network + service legs separately.
// Run: node --test "test/*.test.mjs" from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSendReceipt } from "../src/feat/chain/utils/sendReceipt.ts";

describe("formatSendReceipt", () => {
  it("renders network, service, and total as separate lines", () => {
    const r = formatSendReceipt({
      networkBaseUnits: "5000",
      serviceBaseUnits: "2500",
      decimals: 9,
      symbol: "SOL",
    });
    assert.equal(r.networkFee, "0.000005 SOL");
    assert.equal(r.serviceFee, "0.0000025 SOL");
    assert.equal(r.totalFee, "0.0000075 SOL");
  });

  it("renders dust-scale legs exactly (no float rounding to zero)", () => {
    const r = formatSendReceipt({
      networkBaseUnits: "1",
      serviceBaseUnits: "1",
      decimals: 18,
      symbol: "MON",
    });
    assert.equal(r.networkFee, "0.000000000000000001 MON");
    assert.equal(r.serviceFee, "0.000000000000000001 MON");
    assert.equal(r.totalFee, "0.000000000000000002 MON");
  });

  it("handles a zero service leg without dropping the line", () => {
    const r = formatSendReceipt({
      networkBaseUnits: "5000",
      serviceBaseUnits: "0",
      decimals: 9,
      symbol: "SOL",
    });
    assert.equal(r.networkFee, "0.000005 SOL");
    assert.equal(r.serviceFee, "0 SOL");
    assert.equal(r.totalFee, "0.000005 SOL");
  });

  it("throws on non-integer legs instead of rendering a guess", () => {
    assert.throws(() =>
      formatSendReceipt({ networkBaseUnits: "5.5", serviceBaseUnits: "0", decimals: 9, symbol: "SOL" }),
    );
  });
});
