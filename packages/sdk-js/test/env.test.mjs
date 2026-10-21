// Smallest runnable check for env detection + preset resolution.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEnv, Peridot } from "../dist/esm/index.js";

function withNodeEnv(value, fn) {
  const saved = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

test("detectEnv: only 'production' is production, everything else sandbox", () => {
  withNodeEnv("production", () => assert.equal(detectEnv(), "production"));
  for (const v of ["development", "staging", "test", "", "PRODUCTION"]) {
    withNodeEnv(v, () => assert.equal(detectEnv(), "sandbox", `NODE_ENV=${JSON.stringify(v)}`));
  }
  withNodeEnv(undefined, () => assert.equal(detectEnv(), "sandbox"));
});

test("Peridot presets: env picks the canonical hosts; custom baseUrl drops the popup preset", () => {
  withNodeEnv("production", () => {
    assert.equal(Peridot().popupBaseUrl, "https://peridot.id");
    // Explicit env override wins (e.g. a production build targeting sandbox).
    assert.equal(Peridot({ env: "sandbox" }).popupBaseUrl, "https://sandbox.peridot.id");
  });
  withNodeEnv("development", () => {
    assert.equal(Peridot().popupBaseUrl, "https://sandbox.peridot.id");
    assert.equal(Peridot({ env: "production" }).popupBaseUrl, "https://peridot.id");
  });
  // Caller brings the API origin → caller brings the popup host (first-party inline).
  assert.equal(Peridot({ baseUrl: "http://localhost:3301" }).popupBaseUrl, undefined);
});

test("Peridot presets: canonical API hosts (AC-D3)", () => {
  withNodeEnv("production", () => {
    // No direct baseUrl getter — verify via a captured fetch.
    const origFetch = globalThis.fetch;
    let seen = "";
    globalThis.fetch = async (url) => {
      seen = String(url);
      return { ok: true, headers: { get: () => "application/json" }, json: async () => ({ env: "production" }) };
    };
    try {
      return Peridot().checkEnv("production").then((r) => {
        assert.equal(seen, "https://api.peridot.id/v1/env");
        assert.equal(r.ok, true);
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
