// Task 011 — End-to-end devnet transaction through the SDK surface.
//
// Exercises the FULL on-chain flow against the real devnet program:
//   backend-gated initialize (passkey-signed) → top-up (deposit) →
//   passkey-authorized withdrawal → verify balance + nonce on devnet.
//
// Requires the devnet program built with PID_BACKEND = this backend, and:
//   PID_RELAYER_SECRET=64-byte-hex  PID_TREASURY_PUBKEY=base58  (dev backend keypair)
// The Google-OAuth browser leg (Playwright + virtual authenticator) is the documented
// follow-up in docs/tasks/011-e2e-devnet-transaction.md; here the API is mocked and the
// passkey is synthetic, so the on-chain contract is the thing under test.
//
// Run: node --import tsx test/devnet.e2e.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PeridotWallet } from "@peridotvault/pid-sdk-js";
import { SolanaAdapter, SolanaRpc, b64url, buildWebAuthnMessage, pidToSeed32, toHex } from "@peridotvault/pid-solana";
const RP_ID_HASH = crypto.createHash("sha256").update("peridot-id.example").digest();

const BACKEND_SECRET = process.env.PID_RELAYER_SECRET;
assert.ok(BACKEND_SECRET && /^[0-9a-fA-F]{128}$/.test(BACKEND_SECRET), "PID_RELAYER_SECRET (64-byte hex) required");
assert.ok(process.env.PID_TREASURY_PUBKEY, "PID_TREASURY_PUBKEY required");
const TREASURY = process.env.PID_TREASURY_PUBKEY;
const backend = Keypair.fromSecretKey(Buffer.from(BACKEND_SECRET, "hex"));

const RPC = "https://api.devnet.solana.com";
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const conn = new Connection(RPC, "confirmed");
const PID = "ifal@pid";
const PROGRAM_ID = "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT";
const CHAIN_VIEW = {
  id: "chain-sol",
  namespace: "solana",
  reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
  name: "solana-devnet",
  nativeSymbol: "SOL",
  decimals: 9,
  rpcUrls: [RPC],
  explorerUrl: null,
  logoUrl: null,
  isTestnet: true,
  isActive: true,
  contracts: [{ id: "k1", chainId: "chain-sol", type: "program", address: PROGRAM_ID, versionLabel: "v1", deployTxHash: null, isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
};

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
      if (path === "/v1/identity/me") return { ok: true, data: { pid: PID } };
      if (path === "/v1/account") return { ok: true, data: [{ id: "c1", pid: PID, chainId: "chain-sol", chainNamespace: "solana", chainReference: "ref", address: "x", accountType: "smart_account", status: "active", createdAt: new Date().toISOString() }] };
      if (path === "/v1/credentials") return { ok: true, data: [{ id: "a1", type: "secp256r1", credentialId: "cred", publicKey: AUTHORITY_B64, createdAt: new Date().toISOString(), lastUsedAt: null }] };
      if (path === "/v1/chains") return { ok: true, data: [CHAIN_VIEW] };
      return { ok: true, data: {} };
    },
    async post(path) {
      if (path === "/v1/wallet/withdraw/quote") {
        const rpc = new SolanaRpc(RPC);
        const adapter = new SolanaAdapter(rpc);
        const fee = await adapter.estimateWithdrawFee();
        return { ok: true, data: { networkFeeLamports: fee.toString(), protocolFeeBps: 5000, feePolicyVersion: 1, totalFeeLamports: (fee + fee / 2n).toString(), chainTime: Math.floor(Date.now() / 1000), treasury: TREASURY } };
      }
      return { ok: true, data: {} };
    },
  };

  const signer = {
    async sign(challenge) {
      const cj = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(challenge), origin: "https://peridot-id.example" }));
      const ad = Buffer.concat([RP_ID_HASH, Buffer.from([0x05, 0, 0, 0, 1])]);
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
    passkeySigner: signer,
    feePayerStore: { get: async (k) => storeMap.get(k) ?? null, set: async (k, v) => storeMap.set(k, v) },
  });

  // Backend-gated, passkey-signed initialize (idempotent — skip if live).
  const { SolanaAdapter: Adapter, SolanaRpc: Rpc } = await import("@peridotvault/pid-solana");
  const direct = new Adapter(new Rpc(RPC));
  const authorityComp = Buffer.from(AUTHORITY_B64, "base64url");
  if (!(await direct.isInitialized(PID))) {
    const initSig = await direct.initialize(PID, authorityComp, RP_ID_HASH, backend, signer);
    await conn.confirmTransaction(initSig, "confirmed");
    console.log("initialize OK:", initSig);
  } else {
    console.log("already initialized — reusing devnet PDA");
  }

  // Top-up is deposit-only now (creation is the step above).
  const t = await wallet.topup({ amount: "10000000", asset: "SOL" });
  await conn.confirmTransaction(t.signature, "confirmed");
  const initStatus = await wallet.getTransactionStatus(t.signature);
  assert.equal(initStatus.confirmed, true, "top-up (deposit) confirmed");
  console.log("top-up OK:", t.signature);

  const balance = await wallet.getBalance();
  console.log("smart account balance:", balance);
  assert.ok(balance >= 10_000_000, "deposit landed");

  // Passkey-authorized withdrawal via the adapter (mock API cannot broadcast).
  const { buildWithdrawPayloadV3 } = await import("@peridotvault/pid-solana");
  const nonce = await direct.getNonce(PID);
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const networkFee = await direct.estimateWithdrawFee();
  const treasury = new PublicKey(TREASURY);
  const payload = await buildWithdrawPayloadV3(pidToSeed32(PID), nonce, 5_000_000n, dest.publicKey, expiry, 1);
  const assertion = await signer.sign(payload);
  const wSig = await direct.sponsoredWithdrawSolV3(
    PID, authorityComp, dest.publicKey, 5_000_000n, 1, networkFee, nonce, expiry, assertion, backend, treasury,
  );
  await conn.confirmTransaction(wSig, "confirmed");
  const wStatus = await direct.getStatus(wSig);
  assert.equal(wStatus.confirmed, true, "withdraw confirmed");
  console.log("withdraw OK:", wSig, "CU:", wStatus.computeUnits);

  const destBalance = await conn.getBalance(dest.publicKey);
  assert.equal(destBalance, 5_000_000, "destination received 5M lamports");

  console.log("DEVNET E2E OK");
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });