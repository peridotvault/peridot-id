// Admin provider catalogue helpers (pure logic). Run: `node --test test/`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readiness, needsIconFallback, groupByCategory, policySummary } from "../src/feat/admin/provider-utils.ts";

const base = {
  code: "google",
  name: "Google",
  imageUrl: null,
  category: "web2",
  protocol: "oauth",
  isAvailable: false,
  adapter: "google",
  isSupported: true,
  isConfigured: true,
  configSource: "database",
  oauth: null,
};

describe("provider readiness", () => {
  it("never claims a provider without an adapter is ready", () => {
    assert.deepEqual(readiness({ ...base, isSupported: false }), { label: "Adapter missing", tone: "warn" });
  });

  it("reports unconfigured OAuth, disabled, then ready", () => {
    assert.equal(readiness({ ...base, isConfigured: false }).label, "Not configured");
    assert.equal(readiness({ ...base, isAvailable: false }).label, "Disabled");
    assert.equal(readiness({ ...base, isAvailable: true }).label, "Ready");
  });
});

describe("icon fallback", () => {
  it("falls back on missing or blank URLs only", () => {
    assert.equal(needsIconFallback(null), true);
    assert.equal(needsIconFallback("   "), true);
    assert.equal(needsIconFallback("https://cdn.example.com/x.png"), false);
  });
});

describe("grouping and chain policy", () => {
  it("groups by category without dropping rows", () => {
    const grouped = groupByCategory([
      { ...base },
      { ...base, code: "phantom", category: "web3" },
    ]);
    assert.equal(grouped.web2.length, 1);
    assert.equal(grouped.web3.length, 1);
  });

  it("treats an empty selection as unconfigured, never all chains", () => {
    assert.equal(policySummary({ namespace: "eip155", mode: "all", selections: [] }), "All chains in family");
    assert.match(policySummary({ namespace: "eip155", mode: "selected", selections: [] }), /Unconfigured/);
    const chain = { id: "1", namespace: "eip155", reference: "1", name: "Ethereum", isActive: true };
    assert.equal(policySummary({ namespace: "eip155", mode: "selected", selections: [{ chain }] }), "Ethereum");
  });
});
