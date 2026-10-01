// Smallest runnable check for the hosted embed bridge (iframe side).
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";
import { EmbedBridge, EMBED_LOGIN, EMBED_READY, EMBED_TOKEN } from "../dist/esm/index.js";

const PARENT = "https://dapp.test";

function fakeWindow() {
  const listeners = [];
  const posted = [];
  const parent = { postMessage: (msg, origin) => posted.push({ msg, origin }) };
  globalThis.window = {
    parent,
    addEventListener: (_t, cb) => listeners.push(cb),
    removeEventListener: (_t, cb) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return {
    posted,
    emit: (data, origin = PARENT, source = parent) => listeners.forEach((cb) => cb({ data, origin, source })),
  };
}

test("EmbedBridge: ready + login are posted to the parent origin", () => {
  const w = fakeWindow();
  try {
    const bridge = new EmbedBridge(PARENT);
    bridge.ready();
    bridge.requestLogin();
    assert.deepEqual(w.posted[0], { msg: { type: EMBED_READY }, origin: PARENT });
    assert.deepEqual(w.posted[1], { msg: { type: EMBED_LOGIN }, origin: PARENT });
    bridge.destroy();
  } finally {
    delete globalThis.window;
  }
});

test("EmbedBridge: token is delivered only from the parent origin", () => {
  const w = fakeWindow();
  try {
    const bridge = new EmbedBridge(PARENT);
    const tokens = [];
    bridge.onToken((t) => tokens.push(t));

    w.emit({ type: EMBED_TOKEN, token: "good" });
    w.emit({ type: EMBED_TOKEN, token: "evil" }, "https://attacker.test");
    assert.deepEqual(tokens, ["good"]);
    bridge.destroy();
  } finally {
    delete globalThis.window;
  }
});
