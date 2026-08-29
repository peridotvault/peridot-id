// Task 006 acceptance: adapter build → sign (mock passkey) → submit → confirm a withdrawal.
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaRpc, SolanaAdapter, buildWebAuthnMessage, base64url } from "@antigane/solana/dist/index.js";

const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const rpc = new SolanaRpc("http://127.0.0.1:8899");
const adapter = new SolanaAdapter(rpc);
const accountId = crypto.randomUUID();

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
        type: "webauthn.get", challenge: base64url(challenge), origin: "https://peridot-id.example",
      }));
      const authenticatorData = Buffer.alloc(37);
      authenticatorData.writeUInt32BE(1, 33);
      const md = buildWebAuthnMessage(authenticatorData, clientDataJSON);
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
  const feePayer = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(feePayer.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
  const dest = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(dest.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  const signer = mockPasskeySigner(passkey);

  // initialize
  const initSig = await adapter.initialize(accountId, authorityComp, feePayer);
  await conn.confirmTransaction(initSig, "confirmed");
  assert.equal(await adapter.isInitialized(accountId), true, "initialized");
  console.log("init OK", initSig);

  // deposit
  const depSig = await adapter.depositSol(accountId, feePayer, 10_000_000n);
  await conn.confirmTransaction(depSig, "confirmed");
  console.log("deposit OK; balance:", await adapter.getBalance(accountId));

  // withdraw (mock passkey)
  const nonceBefore = await adapter.getNonce(accountId);
  const wSig = await adapter.withdrawSol(accountId, authorityComp, dest.publicKey, 5_000_000n, feePayer, signer);
  await conn.confirmTransaction(wSig, "confirmed");
  const status = await adapter.getStatus(wSig);
  assert.equal(status.confirmed, true, "withdraw confirmed");
  const nonceAfter = await adapter.getNonce(accountId);
  assert.equal(nonceAfter, nonceBefore + 1n, "nonce incremented");
  console.log("withdraw OK; nonce", nonceBefore.toString(), "->", nonceAfter.toString(), "CU:", status.computeUnits);

  // getAddress is deterministic
  console.log("smart account:", adapter.getAddress(accountId).toBase58());
  console.log("ADAPTER E2E OK");
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
