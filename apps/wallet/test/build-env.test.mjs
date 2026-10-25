// ANT-346 M11: staging/prod bundles must bake in an https API URL.
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prodApiUrlError } from "../vite.check.ts";

describe("prodApiUrlError", () => {
  it("passes https in production and anything unset", () => {
    assert.equal(prodApiUrlError("https://api.peridot.id", "production"), null);
    assert.equal(prodApiUrlError(undefined, "production"), null);
  });

  it("fails http in production", () => {
    assert.match(prodApiUrlError("http://api.example.com", "production") ?? "", /https/);
  });

  it("fails garbage URLs regardless of mode", () => {
    assert.match(prodApiUrlError(":::", "production") ?? "", /valid URL/);
  });

  it("allows http outside production (dev serve/preview)", () => {
    assert.equal(prodApiUrlError("http://localhost:3300", "development"), null);
    assert.equal(prodApiUrlError("http://192.168.1.10:3300", "development"), null);
  });
});
