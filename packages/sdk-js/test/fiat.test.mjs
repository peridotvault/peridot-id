// Smallest runnable check for the combined Transfer Fee helper.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";
import { sumTransferFee } from "../dist/esm/index.js";

test("sumTransferFee: PeridotID (fee+PPN) + DOKU (fee+PPN)", () => {
  assert.equal(
    sumTransferFee({ peridotFeeIdr: "100", peridotTaxIdr: "11", gatewayFeeIdr: "2500", gatewayTaxIdr: "275" }),
    "2886",
  );
});

test("sumTransferFee: missing gateway parts count as 0 (verified app, no gateway fee)", () => {
  assert.equal(sumTransferFee({ peridotFeeIdr: "0", peridotTaxIdr: "0" }), "0");
  assert.equal(sumTransferFee({ peridotFeeIdr: "100", peridotTaxIdr: "11" }), "111");
});
