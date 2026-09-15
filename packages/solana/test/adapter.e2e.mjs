// Adapter acceptance: passkey-signed initialize → deposit → sponsored withdraw.
// Runs against the local validator with the TEST backend build:
//   PID_BACKEND=5as9TQo7Ua5iEBCKRbPhFUiRQX5dRJpjEQ9V91WddzaZ cargo build-sbf
//   solana-test-validator --reset --bpf-program CiwLJ1h... <so> &
//   node packages/solana/test/adapter.e2e.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import pkg from "../dist/index.js";
const { SolanaRpc, SolanaAdapter, buildWebAuthnMessage, buildWithdrawPayload, b64url } = pkg;

const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const rpc = new SolanaRpc("http://127.0.0.1:8899");
const adapter = new SolanaAdapter(rpc);
const accountId = crypto.randomUUID();

// Test-only backend (must match the program's PID_BACKEND build const).
const backend = Keypair.fromSecretKey(Buffer.from([2,165,58,5,85,113,187,187,189,165,0,247,194,28,78,38,100,30,150,157,210,65,241,136,120,108,19,175,51,247,44,88,68,27,157,74,181,156,0,3,4,104,44,101,23,145,208,210,131,227,116,208,145,70,66,152,114,42,243,151,173,78,79,158]));

function compressedPub(pub) {
  const der = pub.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 65);
  const X = raw.subarray(1, 33);
  return Buffer.concat([Buffer.from([(raw[64] & 1) ? 0x03 : 0x02]), X]);
}

// Mock passkey signer: builds a WebAuthn-style assertion over the given challenge.
function mockPasskeySigner(keypair) {
  return {
    async sign(challenge) {
      const clientDataJSON = Buffer.from(JSON.stringify({
        type: "webauthn.get", challenge: b64url(challenge), origin: "https://peridot-id.example",
      }));
      const authenticatorData = Buffer.alloc(37);
      authenticatorData.writeUInt32BE(1, 33);
      const md = await buildWebAuthnMessage(authenticatorData, clientDataJSON);
      let sig = crypto.sign("sha256", md, { key: keypair.privateKey, dsaEncoding: "ieee-p1363" });
      const r = BigInt("0x" + sig.subarray(0, 32).toString("hex"));
      let s = BigInt("0x" + sig.subarray(32).toString("hex"));
      if (s > N / 2n) s = N - s;
      sig = Buffer.concat([
        Buffer.from(r.toString(16).padStart(64, "0"), "hex"),
        Buffer.from(s.toString(16).padStart(64, "0"), "hex"),
      ]);
      return { credentialId: "cred-1", signature: sig, authenticatorData, clientDataJSON };
    },
  };
}

async function main() {
  const passkey = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const authorityComp = compressedPub(passkey.publicKey);
  await conn.confirmTransaction(await conn.requestAirdrop(backend.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
  const dest = Keypair.generate();
  const treasury = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(treasury.publicKey, LAMPORTS_PER_SOL), "confirmed");
  const signer = mockPasskeySigner(passkey);

  // initialize (backend-paid, passkey-signed)
  const initSig = await adapter.initialize(accountId, authorityComp, backend, signer);
  await conn.confirmTransaction(initSig, "confirmed");
  assert.equal(await adapter.isInitialized(accountId), true, "initialized");
  console.log("init OK", initSig);

  // deposit
  const depSig = await adapter.depositSol(accountId, backend, 10_000_000n);
  await conn.confirmTransaction(depSig, "confirmed");
  console.log("deposit OK; balance:", await adapter.getBalance(accountId));

  // sponsored withdraw (treasury-bound challenge)
  const nonce = await adapter.getNonce(accountId);
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const fee = 100_000n;
  const payload = await buildWithdrawPayload(nonce, 5_000_000n, dest.publicKey, expiry, fee, treasury.publicKey);
  const assertion = await signer.sign(payload);
  const wSig = await adapter.sponsoredWithdrawSol(
    accountId, authorityComp, dest.publicKey, 5_000_000n, fee, nonce, expiry, assertion, backend, treasury.publicKey,
  );
  await conn.confirmTransaction(wSig, "confirmed");
  const status = await adapter.getStatus(wSig);
  assert.equal(status.confirmed, true, "withdraw confirmed");
  assert.equal(await adapter.getNonce(accountId), nonce + 1n, "nonce incremented");
  assert.equal(await conn.getBalance(dest.publicKey), 5_000_000, "dest received amount");
  console.log("withdraw OK; nonce", nonce.toString(), "->", (nonce + 1n).toString(), "CU:", status.computeUnits);

  console.log("smart account:", adapter.getAddress(accountId).toBase58());
  console.log("ADAPTER E2E OK");
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
