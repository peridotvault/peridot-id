// Smallest runnable check for the login popup open/fallback/resolve logic.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
import { test } from "node:test";
import assert from "node:assert/strict";

const POPUP_ORIGIN = "https://app.pid.peridotvault.com";
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
