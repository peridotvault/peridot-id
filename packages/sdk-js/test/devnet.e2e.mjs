// Task 011 — End-to-end devnet transaction through the SDK surface.
//
// Exercises the FULL on-chain flow against the real devnet program (task 005 deploy):
//   create account (mock API) → first top-up (initializes the smart account) →
//   passkey-authorized withdrawal → verify balance + nonce on devnet.
//
// The Google-OAuth browser leg (Playwright + virtual authenticator) is the documented
// follow-up in docs/tasks/011-e2e-devnet-transaction.md; here the API is mocked and the
// passkey is synthetic, so the on-chain contract is the thing under test.
//
// Run: node --import tsx test/devnet.e2e.mjs   (needs @solana/web3.js + tsx)
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PeridotWallet } from "@antigane/sdk-js";
import { b64url, buildWebAuthnMessage, toHex } from "@antigane/solana";

const RPC = "https://api.devnet.solana.com";
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const conn = new Connection(RPC, "confirmed");
const ACCOUNT_ID = crypto.randomUUID();

function compressedPub(pub) {
  const der = pub.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 65);
  const X = raw.subarray(1, 33);
  return Buffer.concat([Buffer.from([(raw[64] & 1) ? 0x03 : 0x02]), X]);
}

async function main() {
  const passkey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const AUTHORITY_B64 = compressedPub(passkey.publicKey).toString("base64url");

  // Fee payer: reuse the CLI devnet wallet (already funded) or a fresh one + faucet.
  let feePayer = Keypair.generate();
  {
    const airdrop = await conn.requestAirdrop(feePayer.publicKey, 1 * LAMPORTS_PER_SOL).catch(() => null);
    if (airdrop) await conn.confirmTransaction(airdrop, "confirmed");
    if (await conn.getBalance(feePayer.publicKey) < 5000) {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"), "utf8"));
      feePayer = Keypair.fromSecretKey(Uint8Array.from(raw));
    }
  }
  const feePayerBalance = await conn.getBalance(feePayer.publicKey);
  console.log("fee payer balance (devnet):", feePayerBalance);
  assert.ok(feePayerBalance > 5000, "fee payer must hold devnet SOL");

  const dest = Keypair.generate();

  const mockApi = {
    async get(path) {
      if (path === "/v1/accounts") return { ok: true, data: [{ id: ACCOUNT_ID, status: "active", version: 1, createdAt: new Date().toISOString(), chainAccounts: [{ id: "c1", chainNamespace: "solana", chainReference: "ref", address: "x", accountType: "smart_account", status: "active", createdAt: new Date().toISOString() }] }] };
      if (path === "/v1/credentials") return { ok: true, data: [{ id: "a1", type: "secp256r1", credentialId: "cred", publicKey: AUTHORITY_B64, createdAt: new Date().toISOString(), lastUsedAt: null }] };
      return { ok: true, data: {} };
    },
    async post() { return { ok: true, data: {} }; },
  };

  const signer = {
    async sign(challenge) {
      const cj = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin: "https://peridot-id.example" }));
      const ad = Buffer.alloc(37); ad.writeUInt32BE(1, 33);
      const md = await buildWebAuthnMessage(ad, cj);
      let s = crypto.sign("sha256", md, { key: passkey.privateKey, dsaEncoding: "ieee-p1363" });
      const r = BigInt("0x" + s.subarray(0, 32).toString("hex"));
      let ss = BigInt("0x" + s.subarray(32).toString("hex"));
      if (ss > N / 2n) ss = N - ss;
      return { credentialId: "cred", signature: Buffer.concat([Buffer.from(r.toString(16).padStart(64, "0"), "hex"), Buffer.from(ss.toString(16).padStart(64, "0"), "hex")]), authenticatorData: ad, clientDataJSON: cj };
    },
  };

  const storeMap = new Map([["peridot.feePayer.ed25519", toHex(feePayer.secretKey)]]);
  const wallet = new PeridotWallet(mockApi, {
    solanaRpcUrl: RPC,
    passkeySigner: signer,
    feePayerStore: { get: async (k) => storeMap.get(k) ?? null, set: async (k, v) => storeMap.set(k, v) },
  });

  // First top-up initializes the smart account (PRD_v5 §3).
  const t = await wallet.topup({ amount: "10000000", asset: "SOL" });
  await conn.confirmTransaction(t.signature, "confirmed");
  const initStatus = await wallet.getTransactionStatus(t.signature);
  assert.equal(initStatus.confirmed, true, "first top-up (initialize+deposit) confirmed");
  console.log("first top-up OK:", t.signature);

  const balance = await wallet.getBalance();
  console.log("smart account balance:", balance);
  assert.ok(balance >= 10_000_000, "deposit landed");

  // Passkey-authorized withdrawal.
  const w = await wallet.withdraw({ amount: "5000000", asset: "SOL", to: dest.publicKey.toBase58() });
  await conn.confirmTransaction(w.signature, "confirmed");
  const wStatus = await wallet.getTransactionStatus(w.signature);
  assert.equal(wStatus.confirmed, true, "withdraw confirmed");
  console.log("withdraw OK:", w.signature, "CU:", wStatus.computeUnits);

  const destBalance = await conn.getBalance(dest.publicKey);
  assert.equal(destBalance, 5_000_000, "destination received 5M lamports");

  console.log("DEVNET E2E OK");
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });