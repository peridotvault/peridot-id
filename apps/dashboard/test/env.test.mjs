// One dashboard origin, two APIs: the testnet base is derived from the
// configured mainnet one, and local dev keeps a single API.
// Run: `node --test "test/*.test.mjs"` from apps/dashboard.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { testnetSibling } from "../src/shared/lib/config.ts";

describe("testnetSibling", () => {
  it("maps the canonical API host to its sandbox sibling", () => {
    assert.equal(testnetSibling("https://api.peridot.id"), "https://sandbox-api.peridot.id");
  });

  it("keeps one API for local dev (loopback + LAN)", () => {
    assert.equal(testnetSibling("http://localhost:3300"), "http://localhost:3300");
    assert.equal(testnetSibling("http://127.0.0.1:3300"), "http://127.0.0.1:3300");
    assert.equal(testnetSibling("http://192.168.1.20:3300"), "http://192.168.1.20:3300");
  });

  it("leaves non-API hosts and garbage alone", () => {
    assert.equal(testnetSibling("https://peridot.id"), "https://peridot.id");
    assert.equal(testnetSibling("not-a-url"), "not-a-url");
  });
});
