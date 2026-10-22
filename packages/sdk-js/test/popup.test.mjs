// Smallest runnable check for the login popup open/fallback/resolve logic.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";

const POPUP_ORIGIN = "https://peridot.id";
const DAPP_ORIGIN = "https://dapp.example";

function popupMock() {
  return { closed: false, close() { this.closed = true; }, postMessage() {} };
}

/** Install a fake opener window; `openImpl` decides what window.open returns. */
async function withOpener(openImpl, fn) {
  const saved = globalThis.window;
  const listeners = {};
  const w = {
    location: { origin: DAPP_ORIGIN },
    screenX: 0,
    screenY: 0,
    innerWidth: 1200,
    innerHeight: 800,
    open: openImpl,
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] ?? []).filter((h) => h !== handler);
    },
    emit(type, event) { for (const handler of listeners[type] ?? []) handler(event); },
  };
  globalThis.window = w;
  try {
    return await fn(w);
  } finally {
    globalThis.window = saved;
  }
}

test("openLoginPopup: opens a centered popup and resolves with pidCode", async () => {
  const { openLoginPopup } = await import("../dist/esm/popup.js");
  const win = popupMock();
  const calls = [];
  await withOpener(
    (url, name, features) => (calls.push({ url, name, features }), win),
    async (opener) => {
      const p = openLoginPopup({ popupBaseUrl: POPUP_ORIGIN, params: { popup: "login", origin: DAPP_ORIGIN } });
      assert.equal(calls.length, 1, "exactly one window.open");
      assert.match(calls[0].url, /popup=login/);
      assert.match(calls[0].features, /popup=1/);
      opener.emit("message", {
        source: win,
        origin: POPUP_ORIGIN,
        data: { type: "pid-popup-result", ok: true, data: { pidCode: "abc" } },
      });
      assert.deepEqual(await p, { pidCode: "abc" });
      assert.equal(win.closed, true, "popup closes after delivering the code");
    },
  );
});

test("openLoginPopup: falls back to a tab when the popup is blocked", async () => {
  const { openLoginPopup } = await import("../dist/esm/popup.js");
  const win = popupMock();
  const calls = [];
  await withOpener(
    (url, name) => (calls.push({ url, name }), calls.length === 1 ? null : win),
    async (opener) => {
      const p = openLoginPopup({ popupBaseUrl: POPUP_ORIGIN, params: { popup: "login", origin: DAPP_ORIGIN } });
      assert.equal(calls.length, 2, "popup then tab");
      assert.equal(calls[0].name, "peridot-popup");
      assert.equal(calls[1].name, "_blank", "tab fallback");
      opener.emit("message", {
        source: win,
        origin: POPUP_ORIGIN,
        data: { type: "pid-popup-result", ok: true, data: { pidCode: "z" } },
      });
      assert.deepEqual(await p, { pidCode: "z" });
    },
  );
});

test("openLoginTab: opens a new tab directly", async () => {
  const { openLoginTab } = await import("../dist/esm/popup.js");
  const win = popupMock();
  const calls = [];
  await withOpener(
    (url, name) => (calls.push({ url, name }), win),
    (opener) => {
      const p = openLoginTab({ popupBaseUrl: POPUP_ORIGIN, params: { popup: "login", origin: DAPP_ORIGIN } });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, "_blank");
      opener.emit("message", {
        source: win,
        origin: POPUP_ORIGIN,
        data: { type: "pid-popup-result", ok: false, error: "access_denied" },
      });
      return assert.rejects(p, /access_denied/);
    },
  );
});

/** Install a fake hosted (wallet-side) window. `store` persists across the
 *  calls of one tab (sessionStorage survives a navigation, not a new window). */
async function withHostedWindow(search, fn, store = new Map()) {
  const saved = globalThis.window;
  globalThis.window = {
    location: { search },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
  };
  try {
    return await fn();
  } finally {
    globalThis.window = saved;
  }
}

test("readPopupParams: approval params survive the OAuth round-trip", async () => {
  const { readPopupParams, clearPopupParams } = await import("../dist/esm/popup.js");
  const store = new Map();
  await withHostedWindow(`?popup=fiat-transfer&origin=${DAPP_ORIGIN}`, () => {
    assert.deepEqual(readPopupParams(), { action: "fiat-transfer", origin: DAPP_ORIGIN });
  }, store);
  // Callback returns to the bare wallet origin — no query params.
  await withHostedWindow("", () => {
    assert.deepEqual(readPopupParams(), { action: "fiat-transfer", origin: DAPP_ORIGIN });
    clearPopupParams();
    assert.equal(readPopupParams(), null);
  }, store);
});

test("readPopupParams: login is not persisted here (has its own context)", async () => {
  const { readPopupParams } = await import("../dist/esm/popup.js");
  const store = new Map();
  await withHostedWindow(`?popup=login&origin=${DAPP_ORIGIN}`, () => {
    assert.equal(readPopupParams()?.action, "login");
  }, store);
  await withHostedWindow("", () => {
    assert.equal(readPopupParams(), null);
  }, store);
});

test("readPopupParams: parses the first-party flag", async () => {
  const { readPopupParams } = await import("../dist/esm/popup.js");
  await withHostedWindow(`?popup=login&origin=${DAPP_ORIGIN}&first_party=1`, () => {
    const p = readPopupParams();
    assert.equal(p?.action, "login");
    assert.equal(p?.firstParty, true);
    assert.equal(p?.clientId, undefined, "first-party login needs no client_id");
  });
});

test("readPopupParams: parses the session scope", async () => {
  const { readPopupParams } = await import("../dist/esm/popup.js");
  await withHostedWindow(`?popup=login&origin=${DAPP_ORIGIN}&first_party=1&session_scope=web`, () => {
    assert.equal(readPopupParams()?.sessionScope, "web");
  });
});

test("readPopupParams: expected_pid is parsed and survives the OAuth round-trip", async () => {
  const { readPopupParams, clearPopupParams } = await import("../dist/esm/popup.js");
  const store = new Map();
  await withHostedWindow(`?popup=withdraw&origin=${DAPP_ORIGIN}&expected_pid=live2dev@pid`, () => {
    assert.deepEqual(readPopupParams(), { action: "withdraw", origin: DAPP_ORIGIN, expectedPid: "live2dev@pid" });
  }, store);
  // Callback returns to the bare wallet origin — no query params.
  await withHostedWindow("", () => {
    assert.deepEqual(readPopupParams(), { action: "withdraw", origin: DAPP_ORIGIN, expectedPid: "live2dev@pid" });
    clearPopupParams();
    assert.equal(readPopupParams(), null);
  }, store);
});

test("openPeridotPopup: binds expectedPid in the URL and REQUEST", async () => {
  const { openPeridotPopup } = await import("../dist/esm/popup.js");
  const sent = [];
  const win = popupMock();
  win.postMessage = (msg, target) => sent.push({ msg, target });
  const calls = [];
  await withOpener(
    (url, name, features) => (calls.push({ url, name, features }), win),
    async (opener) => {
      const p = openPeridotPopup({
        popupBaseUrl: POPUP_ORIGIN,
        params: { popup: "withdraw" },
        request: { action: "withdraw", payload: { to: "x" }, expectedPid: "live2dev@pid" },
      });
      assert.match(calls[0].url, /expected_pid=live2dev%40pid/);
      opener.emit("message", { source: win, origin: POPUP_ORIGIN, data: { type: "pid-popup-ready" } });
      assert.equal(sent.length, 1);
      assert.equal(sent[0].msg.request.expectedPid, "live2dev@pid");
      opener.emit("message", {
        source: win,
        origin: POPUP_ORIGIN,
        data: { type: "pid-popup-result", ok: true, data: { signature: "s", approvedPid: "live2dev@pid" } },
      });
      assert.deepEqual(await p, { signature: "s", approvedPid: "live2dev@pid" });
    },
  );
});
