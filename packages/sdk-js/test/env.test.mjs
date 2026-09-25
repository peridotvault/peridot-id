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

test("Peridot presets: env picks the hosts; custom baseUrl drops the popup preset", () => {
  withNodeEnv("production", () => {
    assert.equal(Peridot().popupBaseUrl, "https://app.pid.peridotvault.com");
  });
  withNodeEnv("development", () => {
    assert.equal(Peridot().popupBaseUrl, "https://app.sandbox.pid.peridotvault.com");
  });
  // Caller brings the API origin → caller brings the popup host (first-party inline).
  assert.equal(Peridot({ baseUrl: "http://localhost:3301" }).popupBaseUrl, undefined);
});
