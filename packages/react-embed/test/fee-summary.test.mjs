// ANT-557: FeeQuoteSummary renders separate fee lines + countdown (SSR).
// Run: pnpm --filter @peridotvault/pid-react-embed test  (builds first via pretest)
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";

const QUOTE = {
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
  raw: {},
};

test("fee-summary exports are present", async () => {
  const mod = await import("../dist/esm/index.js");
  assert.equal(typeof mod.FeeQuoteSummary, "function");
  assert.equal(typeof mod.formatFeeCountdown, "function");
  assert.equal(typeof mod.normalizeFeeQuote, "function");
  assert.equal(typeof mod.classifyFeeFailure, "function");
  assert.equal(typeof mod.shortfallMessage, "function");
});

test("FeeQuoteSummary: separate network/platform lines, never blended-only", async () => {
  const { FeeQuoteSummary } = await import("../dist/esm/index.js");
  const html = renderToString(React.createElement(FeeQuoteSummary, { quote: QUOTE, nowMs: 1_100_000 }));
  assert.match(html, /Network fee/);
  assert.match(html, /Platform fee/);
  assert.match(html, /0\.000005 SOL/);
  assert.match(html, /0\.000017 SOL/);
  assert.match(html, /Total fee/);
  assert.match(html, /0\.000022 SOL/);
  assert.match(html, /Max total you authorize/);
  assert.match(html, /Fee policy/);
  assert.match(html, />2</);
});

test("FeeQuoteSummary: live countdown and expired alert", async () => {
  const { FeeQuoteSummary } = await import("../dist/esm/index.js");
  const live = renderToString(React.createElement(FeeQuoteSummary, { quote: QUOTE, nowMs: 1_100_000 }));
  assert.match(live, /03:20/); // 200s left
  const stale = renderToString(React.createElement(FeeQuoteSummary, { quote: QUOTE, nowMs: 1_300_000 }));
  assert.match(stale, /role="alert"/);
  assert.match(stale, /expired/);
});
