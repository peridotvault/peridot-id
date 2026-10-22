// ANT-89 M3: Level badge — all four states render (SSR, no browser needed).
// Run: pnpm --filter @peridotvault/pid-react-embed test  (builds first via pretest)
import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "react-dom/server";

const VIEW = {
  pid: "ifal@pid",
  level: 5,
  total_xp: 1701,
  current_level_xp: 1701,
  next_level_xp: 2819,
  progress_percentage: 0,
};

test("level badge exports are present", async () => {
  const mod = await import("../dist/esm/index.js");
  assert.equal(typeof mod.PeridotLevelBadge, "function");
  assert.equal(typeof mod.PeridotLevelBadgeView, "function");
  assert.equal(typeof mod.formatBadgeXp, "function");
  assert.equal(typeof mod.levelErrorMessage, "function");
});

test("formatBadgeXp uses thousands separators, never abbreviations", async () => {
  const { formatBadgeXp } = await import("../dist/esm/index.js");
  assert.equal(formatBadgeXp(0), "0");
  assert.equal(formatBadgeXp(1701), "1,701");
  assert.equal(formatBadgeXp(3950079), "3,950,079");
});

test("levelErrorMessage maps the 404 envelope, passes reads through", async () => {
  const { levelErrorMessage } = await import("../dist/esm/index.js");
  assert.equal(levelErrorMessage({ statusCode: 404, message: "Unknown user" }), "Unknown user");
  assert.equal(levelErrorMessage({ statusCode: 500, message: "boom" }), "boom");
  assert.equal(levelErrorMessage({ statusCode: 400, message: ["a", "b"] }), "a b");
  assert.equal(levelErrorMessage(VIEW), null);
});

test("empty state renders without a pid", async () => {
  const { PeridotLevelBadgeView } = await import("../dist/esm/index.js");
  const html = renderToString(React.createElement(PeridotLevelBadgeView, { state: { status: "empty" } }));
  assert.match(html, /No user selected/);
  assert.match(html, /Lv —/);
});

test("loading state renders with status role", async () => {
  const { PeridotLevelBadgeView } = await import("../dist/esm/index.js");
  const html = renderToString(React.createElement(PeridotLevelBadgeView, { state: { status: "loading" } }));
  assert.match(html, /role="status"/);
  assert.match(html, /Loading level/);
});

test("error state renders alert role, message, and retry", async () => {
  const { PeridotLevelBadgeView } = await import("../dist/esm/index.js");
  const html = renderToString(
    React.createElement(PeridotLevelBadgeView, { state: { status: "error", message: "Unknown user" } }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Unknown user/);
  assert.match(html, /Retry/);
});

test("ready state renders level, XP, and progressbar with values", async () => {
  const { PeridotLevelBadgeView } = await import("../dist/esm/index.js");
  const html = renderToString(
    React.createElement(PeridotLevelBadgeView, { state: { status: "ready", summary: VIEW } }),
  );
  assert.match(html, /Lv/);
  assert.match(html, /1,701/);
  assert.match(html, /XP/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /aria-label="Level 5, 1,701 total XP"/);
});

test("ready state hides the bar when showProgress is false", async () => {
  const { PeridotLevelBadgeView } = await import("../dist/esm/index.js");
  const html = renderToString(
    React.createElement(PeridotLevelBadgeView, {
      state: { status: "ready", summary: VIEW },
      showProgress: false,
    }),
  );
  assert.match(html, /Lv/);
  assert.match(html, /aria-label="Level 5, 1,701 total XP"/);
  assert.doesNotMatch(html, /role="progressbar"/);
});
