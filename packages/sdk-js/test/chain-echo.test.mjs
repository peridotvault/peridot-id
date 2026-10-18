// ANT-42 (ANT-41 AC9): wallet assert-on-2xx + submit chain echo.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
// (also picked up by `node --test test/chain-echo.test.mjs`)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertChainEcho,
  buildChainEcho,
  ClusterMismatchError,
  PeridotWallet,
} from "../dist/esm/index.js";

const SELECTED = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

test("assertChainEcho: missing echo follows the legacy path (no throw)", () => {
  assert.doesNotThrow(() => assertChainEcho(undefined, SELECTED));
  assert.doesNotThrow(() => assertChainEcho(null, SELECTED));
});

test("assertChainEcho: missing selected reference follows the legacy path (no throw)", () => {
  assert.doesNotThrow(() => assertChainEcho({ namespace: "solana", reference: "other" }, null));
  assert.doesNotThrow(() => assertChainEcho({ namespace: "solana", reference: "other" }, undefined));
});

test("assertChainEcho: matching echo proceeds", () => {
  assert.doesNotThrow(() =>
    assertChainEcho({ namespace: "solana", reference: SELECTED }, SELECTED),
  );
});

test("assertChainEcho: mismatched reference throws ClusterMismatchError naming expected vs received", () => {
  assert.throws(
    () => assertChainEcho({ namespace: "solana", reference: "mismatched-ref" }, SELECTED),
    (e) => {
      assert.ok(e instanceof ClusterMismatchError);
      assert.equal(e.expectedReference, SELECTED);
      assert.equal(e.receivedReference, "mismatched-ref");
      assert.match(e.message, /cluster-mismatch/);
      assert.match(e.message, new RegExp(SELECTED));
      assert.match(e.message, /mismatched-ref/);
      return true;
    },
  );
});

test("assertChainEcho: wrong namespace throws (never trusts a non-solana echo)", () => {
  assert.throws(
    () => assertChainEcho({ namespace: "eip155", reference: SELECTED }, SELECTED),
    (e) => e instanceof ClusterMismatchError,
  );
});

test("buildChainEcho: symmetric shape with the 2xx echo", () => {
  assert.deepEqual(buildChainEcho(SELECTED), { namespace: "solana", reference: SELECTED });
});

function mockApi(routes) {
  return {
    async get(path) {
      const hit = routes[`GET ${path}`];
      if (!hit) throw new Error(`unexpected GET ${path}`);
      return typeof hit === "function" ? hit() : hit;
    },
    async post(path, body) {
      const hit = routes[`POST ${path}`];
      if (!hit) throw new Error(`unexpected POST ${path}`);
      return typeof hit === "function" ? hit(body) : hit;
    },
  };
}

const compressedKey = Buffer.alloc(33, 2).toString("base64url");

test("submitTransaction: sends chain + keeps legacy network for compat", async () => {
  let sentBody = null;
  const api = mockApi({
    "GET /v1/chains": { ok: true, data: [] },
    "POST /v1/wallet/transactions/submit": (body) => {
      sentBody = body;
      return {
        ok: true,
        data: { id: "tx-1", intentId: "intent-1", network: "devnet", txHash: "sig1" },
      };
    },
  });
  const wallet = new PeridotWallet(api, {});
  const res = await wallet.submitTransaction({
    intentId: "intent-1",
    txHash: "sig1",
    network: "devnet",
    chain: { namespace: "solana", reference: SELECTED },
  });
  assert.equal(res.id, "tx-1");
  assert.deepEqual(sentBody.chain, { namespace: "solana", reference: SELECTED });
  assert.equal(sentBody.network, "devnet");
  assert.equal(sentBody.intentId, "intent-1");
  assert.equal(sentBody.txHash, "sig1");
});

test("submitTransaction: auto-resolves chain from the registry when the caller omits it", async () => {
  let sentBody = null;
  const api = mockApi({
    "GET /v1/chains": {
      ok: true,
      data: [{ namespace: "solana", reference: SELECTED, rpcUrls: [], contracts: [] }],
    },
    "POST /v1/wallet/transactions/submit": (body) => {
      sentBody = body;
      return { ok: true, data: { id: "tx-2", intentId: "i2", txHash: "sig2" } };
    },
  });
  const wallet = new PeridotWallet(api, {});
  await wallet.submitTransaction({ intentId: "i2", txHash: "sig2" });
  assert.deepEqual(sentBody.chain, { namespace: "solana", reference: SELECTED });
});

test("submitTransaction: omits chain when the registry is unreachable (legacy path)", async () => {
  let sentBody = null;
  const api = mockApi({
    "GET /v1/chains": () => {
      throw new Error("offline");
    },
    "POST /v1/wallet/transactions/submit": (body) => {
      sentBody = body;
      return { ok: true, data: { id: "tx-3", intentId: "i3", txHash: "sig3" } };
    },
  });
  const wallet = new PeridotWallet(api, {});
  await wallet.submitTransaction({ intentId: "i3", txHash: "sig3", network: "devnet" });
  assert.equal(sentBody.chain, undefined);
  assert.equal(sentBody.network, "devnet");
});

test("activate: mismatched chain echo blocks sign/broadcast with a cluster-mismatch error", async () => {
  let signCalls = 0;
  const api = mockApi({
    "GET /v1/identity/me": { ok: true, data: { pid: "ifal@pid" } },
    "GET /v1/chains": {
      ok: true,
      data: [{ namespace: "solana", reference: SELECTED, rpcUrls: [], contracts: [] }],
    },
    "GET /v1/account/activation": {
      ok: true,
      data: {
        status: "ready",
        smartAccountAddress: "11111111111111111111111111111111",
        balanceLamports: 1,
        requiredLamports: 1,
        networkFeeLamports: 5000,
        protocolFeeBps: 100,
        chainTime: Math.floor(Date.now() / 1000),
        treasury: "11111111111111111111111111111111",
        feePolicyVersion: 1,
        rpIdHash: Buffer.alloc(32, 1).toString("base64url"),
        chain: { namespace: "solana", reference: "mismatched-ref" },
      },
    },
    "GET /v1/credentials": { ok: true, data: [{ publicKey: compressedKey }] },
  });
  const wallet = new PeridotWallet(api, {
    passkeySigner: {
      async sign() {
        signCalls += 1;
        throw new Error("sign must not be called on cluster mismatch");
      },
    },
  });
  await assert.rejects(() => wallet.activate(), (e) => e instanceof ClusterMismatchError);
  assert.equal(signCalls, 0);
});
