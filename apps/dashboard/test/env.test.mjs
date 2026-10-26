// ANT-694: dashboard env derivation. A sandbox-API build without VITE_PID_ENV
// used to classify as "production" (only loopback meant sandbox), so the
// wallet-popup default pointed at PROD while the API stayed sandbox — the
// popup login "succeeded" but no session ever stuck, with no error shown.
// Run: `node --test test/` from apps/dashboard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePidEnv } from "../src/lib/config.ts";

describe("derivePidEnv", () => {
  it("treats loopback API hosts as sandbox", () => {
    assert.equal(derivePidEnv("http://localhost:3300"), "sandbox");
    assert.equal(derivePidEnv("http://127.0.0.1:3300"), "sandbox");
  });

  it("treats sandbox-indicating API hosts as sandbox (canonical + legacy)", () => {
    assert.equal(derivePidEnv("https://sandbox-api.peridot.id"), "sandbox");
    assert.equal(derivePidEnv("https://api.sandbox.pid.peridotvault.com"), "sandbox");
  });

  it("treats production API hosts as production", () => {
    assert.equal(derivePidEnv("https://api.peridot.id"), "production");
    assert.equal(derivePidEnv("https://api.pid.peridotvault.com"), "production");
  });

  it("falls back to production for unparseable input", () => {
    assert.equal(derivePidEnv(""), "production");
    assert.equal(derivePidEnv("not-a-url"), "production");
  });
});
