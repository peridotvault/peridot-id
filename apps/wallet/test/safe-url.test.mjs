// ANT-346 M10: external URLs must be https (http only for loopback dev).
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSafeExternalUrl } from "../src/shared/safeUrl.ts";

describe("assertSafeExternalUrl", () => {
  it("allows https URLs", () => {
    assert.equal(assertSafeExternalUrl("https://explorer.solana.com/tx/abc").protocol, "https:");
    assert.equal(assertSafeExternalUrl("https://pay.doku.com/checkout?v=1").protocol, "https:");
  });

  it("allows http only for loopback hosts", () => {
    assert.equal(assertSafeExternalUrl("http://localhost:3300/x").hostname, "localhost");
    assert.equal(assertSafeExternalUrl("http://127.0.0.1:3300/x").hostname, "127.0.0.1");
    assert.equal(assertSafeExternalUrl("http://[::1]:3300/x").hostname, "[::1]");
  });

  it("rejects http for non-loopback hosts", () => {
    assert.throws(() => assertSafeExternalUrl("http://example.com/pay"), /non-https/);
    assert.throws(() => assertSafeExternalUrl("http://192.168.1.10:3300/x"), /non-https/);
  });

  it("rejects non-http(s) schemes and garbage", () => {
    assert.throws(() => assertSafeExternalUrl("javascript:alert(1)"), /non-https/);
    assert.throws(() => assertSafeExternalUrl("ftp://example.com/f"), /non-https/);
    assert.throws(() => assertSafeExternalUrl("not a url"), /invalid URL/);
    assert.throws(() => assertSafeExternalUrl(""), /invalid URL/);
  });
});
