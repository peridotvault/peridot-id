// Smoke check for the opener-side package. The postMessage protocol itself is
// covered by @peridotvault/pid-sdk-js test/embed.test.mjs (the EmbedBridge).
// Run: pnpm --filter @peridotvault/pid-react-embed test
import { test } from "node:test";
import assert from "node:assert/strict";

test("react-embed exports the wallet component", async () => {
  const mod = await import("../dist/esm/index.js");
  assert.equal(typeof mod.PeridotWalletEmbed, "function");
});
