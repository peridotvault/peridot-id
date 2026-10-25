// ANT-89 M3: read-only Level helper over GET /v1/users/{pid}/level.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";
import { Peridot } from "../dist/esm/index.js";

// Wire shape mirrors LevelsService.getLevelView (snake_case, ANT-89 §6).
const VIEW = {
  pid: "ifal@pid",
  level: 5,
  total_xp: 1701,
  current_level_xp: 1701,
  next_level_xp: 2819,
  progress_percentage: 0,
};

function captureFetch(handler) {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = saved;
    },
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("level.get hits GET /v1/users/{pid}/level and returns the summary", async () => {
  const cap = captureFetch(async () => json(VIEW));
  try {
    const peridot = Peridot({ baseUrl: "http://localhost:3301" });
    const data = await peridot.level.get("ifal@pid");
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].url, "http://localhost:3301/v1/users/ifal%40pid/level");
    assert.equal(cap.calls[0].init.method, "GET");
    assert.deepEqual(data, VIEW);
  } finally {
    cap.restore();
  }
});

test("level.get passes the 404 envelope through for unknown/deleted users", async () => {
  const cap = captureFetch(async () => json({ statusCode: 404, message: "Unknown user" }, 404));
  try {
    const peridot = Peridot({ baseUrl: "http://localhost:3301" });
    const data = await peridot.level.get("ghost@pid");
    assert.deepEqual(data, { statusCode: 404, message: "Unknown user" });
  } finally {
    cap.restore();
  }
});

test("level.get sends the read-only bearer when set (embed mode)", async () => {
  const cap = captureFetch(async () => json(VIEW));
  try {
    const peridot = Peridot({ baseUrl: "http://localhost:3301", bearer: "read-token" });
    await peridot.level.get("ifal@pid");
    assert.equal(cap.calls[0].init.headers.Authorization, "Bearer read-token");
    assert.equal(cap.calls[0].init.credentials, "omit");
  } finally {
    cap.restore();
  }
});
