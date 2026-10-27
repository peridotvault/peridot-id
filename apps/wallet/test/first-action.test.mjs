// ANT-731 (WS4): lazy first-action utils — refusal detection, quote envelope
// reading, and the inline setup helper against a stub client.
// Run: node --test "test/*.test.mjs" from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ensureAccountAndActivate,
  FIRST_ACTION_REVIEW_NOTICE,
  isFirstActionQuote,
  isNotActivatedError,
} from "../src/feat/chain/utils/firstAction.ts";

const quote = (activation) => ({
  networkFee: "5000",
  platformFee: "17000",
  totalFee: "22000",
  maxTotalFee: "22000",
  feePolicyVersion: 2,
  chainTime: 1000,
  quotedAtMs: 1_000_000,
  expiresAtMs: 1_300_000,
  platformFeeDerived: false,
  maxTotalFeeDefaulted: false,
  ...(activation === undefined ? {} : { activation }),
  raw: {},
});

describe("isNotActivatedError", () => {
  it("matches the pre-lazy backend refusal", () => {
    assert.equal(isNotActivatedError(new Error("Wallet must be activated before sending")), true);
  });

  it("rejects unrelated failures (never hijacks them into setup)", () => {
    for (const msg of ["Insufficient funds", "Network fee moved — re-quote", "", null, undefined, 42]) {
      assert.equal(isNotActivatedError(msg instanceof Error ? msg : new Error(String(msg))), false);
    }
    assert.equal(isNotActivatedError(null), false);
    assert.equal(isNotActivatedError(undefined), false);
  });
});

describe("isFirstActionQuote", () => {
  it("reads only the server envelope", () => {
    assert.equal(
      isFirstActionQuote(quote({ required: true, includedInTotal: true, estimate: "350", mode: "svm-composite" })),
      true,
    );
    assert.equal(isFirstActionQuote(quote({ required: false, includedInTotal: true, estimate: "0", mode: "none" })), false);
    assert.equal(isFirstActionQuote(quote(undefined)), false);
    assert.equal(isFirstActionQuote(null), false);
    assert.equal(isFirstActionQuote(undefined), false);
  });
});

describe("review copy", () => {
  it("never names an activate/create-account step", () => {
    assert.match(FIRST_ACTION_REVIEW_NOTICE, /automatically/);
    assert.doesNotMatch(FIRST_ACTION_REVIEW_NOTICE, /activate|create account|deploy/i);
  });
});

describe("ensureAccountAndActivate", () => {
  const rows = [{ address: "A" }];

  it("activates directly when rows exist", async () => {
    const calls = [];
    const peridot = {
      wallet: {
        me: async () => { calls.push("me"); return rows; },
        createAccount: async () => { calls.push("createAccount"); return rows; },
        activate: async () => { calls.push("activate"); return { status: "activating" }; },
      },
    };
    await ensureAccountAndActivate(peridot);
    assert.deepEqual(calls, ["me", "activate"]);
  });

  it("creates rows first when the account is missing, then activates", async () => {
    const calls = [];
    const peridot = {
      wallet: {
        me: async () => ({ statusCode: 404, message: "missing" }),
        createAccount: async () => { calls.push("createAccount"); return rows; },
        activate: async () => { calls.push("activate"); return { status: "activating" }; },
      },
    };
    await ensureAccountAndActivate(peridot);
    assert.deepEqual(calls, ["createAccount", "activate"]);
  });

  it("throws user-facing copy when setup fails (deposit untouched)", async () => {
    const peridot = {
      wallet: {
        me: async () => rows,
        createAccount: async () => rows,
        activate: async () => ({ statusCode: 409, message: "not ready" }),
      },
    };
    await assert.rejects(() => ensureAccountAndActivate(peridot), /deposit stays in place/);
  });
});
