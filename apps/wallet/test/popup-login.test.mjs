// Login popup context must survive the OAuth round-trip (the callback returns to
// the bare wallet origin, dropping ?popup=/?origin=/?redirect_uri=).
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const DAPP_ORIGIN = "https://dapp.example";
const REDIRECT_URI = "https://dapp.example/auth/callback";

/** Install a fake browser window whose sessionStorage outlives a reload. */
async function withWindow(search, fn) {
  const saved = globalThis.window;
  const store = new Map();
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

describe("readLoginContext", () => {
  it("keeps redirect_uri so the code can be minted for the app's return URL", async () => {
    const { readLoginContext } = await import("../src/feat/auth/utils/popupLogin.ts");
    const url = `?popup=login&origin=${DAPP_ORIGIN}&client_id=pidapp_x&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    await withWindow(url, () => {
      assert.deepEqual(readLoginContext(), { origin: DAPP_ORIGIN, clientId: "pidapp_x", redirectUri: REDIRECT_URI });
      // OAuth returns to CLIENT_SUCCESS_URL — no query params, ctx comes from storage.
      globalThis.window.location.search = "";
      assert.equal(readLoginContext()?.redirectUri, REDIRECT_URI);
    });
  });

  it("ignores a non-http(s) redirect_uri", async () => {
    const { readLoginContext } = await import("../src/feat/auth/utils/popupLogin.ts");
    const url = `?popup=login&origin=${DAPP_ORIGIN}&redirect_uri=${encodeURIComponent("javascript:alert(1)")}`;
    await withWindow(url, () => {
      assert.equal(readLoginContext()?.redirectUri, undefined);
    });
  });

  it("works without redirect_uri (popup login binds the code to the origin)", async () => {
    const { readLoginContext } = await import("../src/feat/auth/utils/popupLogin.ts");
    await withWindow(`?popup=login&origin=${DAPP_ORIGIN}`, () => {
      assert.deepEqual(readLoginContext(), { origin: DAPP_ORIGIN });
    });
  });
});
