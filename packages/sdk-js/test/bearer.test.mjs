// Smallest runnable check for the read-only bearer mode (embed auth).
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";
import { Peridot } from "../dist/esm/index.js";

function captureFetch() {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ pid: "ifal@pid" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}

test("bearer mode: sends Authorization, drops cookies", async () => {
  const cap = captureFetch();
  try {
    const peridot = Peridot({ baseUrl: "http://localhost:3301", bearer: "read-token" });
    await peridot.identity.me();
    const [call] = cap.calls;
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.headers.Authorization, "Bearer read-token");
  } finally {
    cap.restore();
  }
});

test("setBearer swaps back to cookie mode", async () => {
  const cap = captureFetch();
  try {
    const peridot = Peridot({ baseUrl: "http://localhost:3301" });
    peridot.setBearer("read-token");
    await peridot.identity.me();
    assert.equal(cap.calls[0].init.headers.Authorization, "Bearer read-token");

    peridot.setBearer(undefined);
    await peridot.identity.me();
    assert.equal(cap.calls[1].init.credentials, "include");
    assert.equal(cap.calls[1].init.headers.Authorization, undefined);
  } finally {
    cap.restore();
  }
});
