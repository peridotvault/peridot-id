// ANT-346 H2: FeePayerManager defaults to in-memory storage — creating and
// using the default manager must never touch localStorage. localStorage
// persistence is available only via the explicit withLocalStorage() opt-in.
// Runs against the BUILT package (pretest builds): the shipped artifact,
// not the TS source.
// Run: `node --test test/` from packages/core.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FeePayerManager, InMemorySecretStore, LocalStorageSecretStore } from "../dist/index.js";

function trackedLocalStorage() {
  const data = new Map();
  const touches = [];
  return {
    touches,
    api: {
      getItem: (k) => {
        touches.push(["get", k]);
        return data.has(k) ? data.get(k) : null;
      },
      setItem: (k, v) => {
        touches.push(["set", k]);
        data.set(k, v);
      },
      removeItem: (k) => {
        touches.push(["remove", k]);
        data.delete(k);
      },
    },
  };
}

describe("FeePayerManager custody default (ANT-346 H2)", () => {
  it("defaults to the in-memory store and never touches localStorage", async () => {
    const ls = trackedLocalStorage();
    globalThis.localStorage = ls.api;
    try {
      const mgr = new FeePayerManager();
      assert.ok(mgr.store instanceof InMemorySecretStore);
      const address = await mgr.address();
      assert.match(address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      assert.deepEqual(ls.touches, []);
    } finally {
      delete globalThis.localStorage;
    }
  });

  it("persists only via the explicit withLocalStorage() opt-in", async () => {
    const ls = trackedLocalStorage();
    globalThis.localStorage = ls.api;
    try {
      const mgr = FeePayerManager.withLocalStorage();
      assert.ok(mgr.store instanceof LocalStorageSecretStore);
      const first = await mgr.address();
      assert.ok(ls.touches.some(([op]) => op === "set"), "expected a localStorage write");
      // A second manager over the same storage reuses the persisted key.
      const second = FeePayerManager.withLocalStorage();
      assert.equal(await second.address(), first);
    } finally {
      delete globalThis.localStorage;
    }
  });
});
