// ANT-561: Sol activation submit carries the passkey-signed V4 bound.
// Backend ANT-555 400s submits missing maxTotalFeeLamports (spec edge case 2);
// the bound defaults to the quoted totalFee (v2) or the legacy network fee.
// Run: pnpm --filter @peridotvault/pid-sdk-js test
// (also picked up by `node --test test/fee-v2-activate.test.mjs`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { PeridotWallet } from "../dist/esm/index.js";

const PROGRAM = "CiwLJ1hMNjSRdZj2yMVt9bSeRTjVd4pjz7Mxr9yXf6NT";

function mockApi(view) {
  const posts = [];
  return {
    posts,
    async get(path) {
      if (path === "/v1/identity/me") return { ok: true, data: { pid: "alice@pid" } };
      if (path === "/v1/chains") {
        return {
          ok: true,
          data: [
            {
              namespace: "solana",
              reference: "REF",
              rpcUrls: ["http://127.0.0.1:1"],
              contracts: [{ type: "program", address: PROGRAM }],
            },
          ],
        };
      }
      if (path === "/v1/account/activation") return { ok: true, data: view };
      if (path === "/v1/credentials") {
        return {
          ok: true,
          data: [{ credentialId: "cred-1", publicKey: Buffer.from(new Uint8Array(33).fill(7)).toString("base64url") }],
        };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      posts.push({ path, body });
      if (path === "/v1/account/activate") return { ok: true, data: { ...view, status: "activating" } };
      throw new Error(`unexpected POST ${path}`);
    },
  };
}

const signer = {
  async sign() {
    return {
      credentialId: "cred-1",
      signature: new Uint8Array([1, 2]),
      authenticatorData: new Uint8Array([3]),
      clientDataJSON: new Uint8Array([4]),
    };
  },
};

const BASE_VIEW = {
  status: "ready",
  smartAccountAddress: "So11111111111111111111111111111111111111112",
  balanceLamports: 1_000_000_000,
  requiredLamports: 500_000_000,
  networkFeeLamports: 5000,
  protocolFeeBps: 50,
  chainTime: 1_790_000_000,
  treasury: "Treasury1111111111111111111111111111111111111",
  feePolicyVersion: 2,
};

const V2_VIEW = {
  ...BASE_VIEW,
  networkFee: "5000",
  platformFee: "17000",
  totalFee: "22000",
  maxTotalFee: "22000",
  chainMinBaseUnits: "10000",
  quoteId: "q_sol_1",
  quotedAt: "2026-10-25T14:00:00.000Z",
  expiresAt: "2026-10-25T14:05:00.000Z",
};

test("activate posts the offered maxTotalFee bound on v2 views", async () => {
  const api = mockApi(V2_VIEW);
  const wallet = new PeridotWallet(api, { passkeySigner: signer });
  const res = await wallet.activate();
  assert.equal(res.status, "activating");
  assert.equal(api.posts.length, 1);
  const body = api.posts[0].body;
  assert.equal(api.posts[0].path, "/v1/account/activate");
  assert.equal(body.maxTotalFeeLamports, "22000");
  assert.equal(body.quotedNetworkFeeLamports, "5000");
  assert.equal(body.feePolicyVersion, 2);
  assert.ok(body.assertion);
});

test("activate falls back to the legacy network fee on pre-v2 views", async () => {
  const api = mockApi(BASE_VIEW);
  const wallet = new PeridotWallet(api, { passkeySigner: signer });
  await wallet.activate();
  assert.equal(api.posts[0].body.maxTotalFeeLamports, "5000");
});

test("activate honors a raised maxTotalFee (drift headroom)", async () => {
  const api = mockApi({ ...V2_VIEW, maxTotalFee: "30000" });
  const wallet = new PeridotWallet(api, { passkeySigner: signer });
  await wallet.activate();
  assert.equal(api.posts[0].body.maxTotalFeeLamports, "30000");
});

// ANT-895/B2: activate signs the V4 payload (binds maxTotalFee) — the relayer
// only broadcasts activateV4, and a V3-signed assertion would fail on-chain.
test("activate signs the V4 payload binding policy + maxTotalFee + expiry", async () => {
  const { buildActivatePayloadV4, buildActivatePayloadV3, pidToSeed32 } = await import("@peridotvault/pid-solana");
  let signed = null;
  const capturing = {
    async sign(payload) {
      signed = payload;
      return {
        credentialId: "cred-1",
        signature: new Uint8Array([1, 2]),
        authenticatorData: new Uint8Array([3]),
        clientDataJSON: new Uint8Array([4]),
      };
    },
  };
  const api = mockApi(V2_VIEW);
  const wallet = new PeridotWallet(api, { passkeySigner: capturing });
  await wallet.activate();
  assert.ok(signed, "expected a passkey signature");
  const authority = new Uint8Array(33).fill(7);
  const expiry = Math.floor(V2_VIEW.chainTime) + 300;
  const expectedV4 = await buildActivatePayloadV4(
    pidToSeed32("alice@pid"),
    authority,
    V2_VIEW.feePolicyVersion,
    BigInt(V2_VIEW.maxTotalFee),
    expiry,
  );
  assert.deepEqual(Buffer.from(signed), Buffer.from(expectedV4));
  const legacyV3 = await buildActivatePayloadV3(
    pidToSeed32("alice@pid"),
    authority,
    V2_VIEW.feePolicyVersion,
    expiry,
  );
  assert.notDeepEqual(Buffer.from(signed), Buffer.from(legacyV3));
});
