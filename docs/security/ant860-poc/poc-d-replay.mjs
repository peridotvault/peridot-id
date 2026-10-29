// ANT-860 PoC-D (B4): same V3 assertion settles on TWO clusters. Isolated validators only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, TransactionInstruction, LAMPORTS_PER_SOL } from "@solana/web3.js";
const PROGRAM = new PublicKey("4KLMwD1EHjkFPf3DUSeJn55Co529matzUVv2yrpvPC8a");
const SECP = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const DOMAIN_V3 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v3");
const AUTH_PREFIX = crypto.createHash("sha256").update("test-rp").digest();
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const POLICY_V1 = 1;
const A = new Connection("http://127.0.0.1:18999", "confirmed");
const B = new Connection("http://127.0.0.1:19999", "confirmed");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const pidToSeed32 = (pid) => sha256(Buffer.from(pid.trim().toLowerCase(), "utf8"));
function lowS(sig) { const r = BigInt("0x" + sig.subarray(0, 32).toString("hex")); let s = BigInt("0x" + sig.subarray(32).toString("hex")); if (s > N / 2n) s = N - s; const b = Buffer.alloc(64); Buffer.from(r.toString(16).padStart(64, "0"), "hex").copy(b, 0); Buffer.from(s.toString(16).padStart(64, "0"), "hex").copy(b, 32); return b; }
function compressedPub(pub) { const der = pub.export({ format: "der", type: "spki" }); const raw = der.subarray(der.length - 65); const X = raw.subarray(1, 33); return Buffer.concat([Buffer.from([(raw[64] & 1) ? 0x03 : 0x02]), X]); }
const authData = () => Buffer.concat([AUTH_PREFIX, Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
function signPayload(kp, h) { const c = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(h), origin: "test.invalid" })); const m = Buffer.concat([authData(), sha256(c)]); const sig = lowS(crypto.sign("sha256", m, { key: kp.privateKey, dsaEncoding: "ieee-p1363" })); return { clientDataJSON: c, messageData: m, sig, comp: compressedPub(kp.publicKey) }; }
function buildSecpIx(c, s, m) { const o = Buffer.alloc(14); o.writeUInt16LE(49, 0); o.writeUInt16LE(0xffff, 2); o.writeUInt16LE(16, 4); o.writeUInt16LE(0xffff, 6); o.writeUInt16LE(113, 8); o.writeUInt16LE(m.length, 10); o.writeUInt16LE(0xffff, 12); return new TransactionInstruction({ keys: [], programId: SECP, data: Buffer.concat([Buffer.from([1, 0]), o, c, s, m]) }); }
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const [TREASURY_PDA] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM);
const [CONFIG_PDA] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM);

const kV = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authV = compressedPub(kV.publicKey);
const pid = pidToSeed32("pocreplay@pid");
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), pid], PROGRAM);
async function setup(conn, tag) {
  const payer = Keypair.generate(); const dest = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 20e9), "confirmed");
  const admin = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(admin.publicKey, 2e9), "confirmed");
  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: CONFIG_PDA, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([15]), admin.publicKey.toBuffer()]) })), [admin], { commitment: "confirmed", skipPreflight: true });
  } catch {}
  await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: 2 * LAMPORTS_PER_SOL })), [payer], { commitment: "confirmed" }), "confirmed");
  const tA = await conn.getBlockTime(await conn.getSlot());
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([5]), pid, authV, u16(POLICY_V1), i64(tA + 300)]));
  const s = signPayload(kV, h);
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([5]), pid, authV, u16(POLICY_V1), i64(tA + 300), u64(0n), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true });
  await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: 2 * LAMPORTS_PER_SOL })), [payer], { commitment: "confirmed" }), "confirmed");
  return { payer, dest };
}
const a = await setup(A, "A"); const b = await setup(B, "B");
console.log("both clusters: same PDA activated under same key; nonces:",
  (await A.getAccountInfo(pda)).data.readBigUInt64LE(4).toString(), (await B.getAccountInfo(pda)).data.readBigUInt64LE(4).toString());
// ONE assertion (nonce 0, shared expiry) submitted to BOTH clusters
const t0 = await A.getBlockTime(await A.getSlot());
const exp = t0 + 300;
const destBytes = a.dest.publicKey.toBuffer();
const AMOUNT = BigInt(0.2 * LAMPORTS_PER_SOL);
const payload = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([1]), pid, u64(0n), u64(AMOUNT), destBytes, i64(exp), u16(POLICY_V1)]));
const s = signPayload(kV, payload);
async function submitSameAssertion(conn, relayer) {
  return sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: new PublicKey(destBytes), isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: relayer.publicKey, isSigner: true, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([1]), u64(0n), u64(AMOUNT), destBytes, i64(exp), u16(POLICY_V1), u64(100_000n), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [relayer], { commitment: "confirmed", skipPreflight: true });
}
await submitSameAssertion(A, a.payer); console.log("CLUSTER-A withdraw nonce0 OK");
await submitSameAssertion(B, b.payer); console.log("CLUSTER-B withdraw nonce0 OK (same assertion)");
console.log("POC-D DONE: identical V3 assertion settled on two clusters (B4 TERBUKTI — no cluster binding, TTL-only bound)");
