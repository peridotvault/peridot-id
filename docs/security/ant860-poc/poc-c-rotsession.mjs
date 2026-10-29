// ANT-860 PoC-C (B3): session key survives owner rotation. Isolated validator only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, TransactionInstruction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
const PROGRAM = new PublicKey("4KLMwD1EHjkFPf3DUSeJn55Co529matzUVv2yrpvPC8a");
const SECP = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const DOMAIN_V3 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v3");
const DOMAIN_SESSION = Buffer.from("PID|SOLANA|SESSION|v1");
const AUTH_PREFIX = crypto.createHash("sha256").update("test-rp").digest();
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const POLICY_V1 = 1, ACT_FEE = 100_000;
const conn = new Connection("http://127.0.0.1:18999", "confirmed");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const pidToSeed32 = (pid) => sha256(Buffer.from(pid.trim().toLowerCase(), "utf8"));
const [TREASURY_PDA] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM);
const [CONFIG_PDA] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM);
function lowS(sig) { const r = BigInt("0x" + sig.subarray(0, 32).toString("hex")); let s = BigInt("0x" + sig.subarray(32).toString("hex")); if (s > N / 2n) s = N - s; const b = Buffer.alloc(64); Buffer.from(r.toString(16).padStart(64, "0"), "hex").copy(b, 0); Buffer.from(s.toString(16).padStart(64, "0"), "hex").copy(b, 32); return b; }
function compressedPub(pub) { const der = pub.export({ format: "der", type: "spki" }); const raw = der.subarray(der.length - 65); const X = raw.subarray(1, 33); return Buffer.concat([Buffer.from([(raw[64] & 1) ? 0x03 : 0x02]), X]); }
const authData = () => Buffer.concat([AUTH_PREFIX, Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
function signPayload(kp, h) { const c = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(h), origin: "test.invalid" })); const m = Buffer.concat([authData(), sha256(c)]); const sig = lowS(crypto.sign("sha256", m, { key: kp.privateKey, dsaEncoding: "ieee-p1363" })); return { clientDataJSON: c, messageData: m, sig, comp: compressedPub(kp.publicKey) }; }
function buildSecpIx(c, s, m) { const o = Buffer.alloc(14); o.writeUInt16LE(49, 0); o.writeUInt16LE(0xffff, 2); o.writeUInt16LE(16, 4); o.writeUInt16LE(0xffff, 6); o.writeUInt16LE(113, 8); o.writeUInt16LE(m.length, 10); o.writeUInt16LE(0xffff, 12); return new TransactionInstruction({ keys: [], programId: SECP, data: Buffer.concat([Buffer.from([1, 0]), o, c, s, m]) }); }
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const liveNow = async () => conn.getBlockTime(await conn.getSlot());
const sessionPdaOf = (id, k) => PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("session"), id, k.toBuffer()], PROGRAM)[0];

const kOwner = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const kNew = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authO = compressedPub(kOwner.publicKey);
const payer = Keypair.generate(); const sess = Keypair.generate(); const userW = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 20e9), "confirmed");
await conn.confirmTransaction(await conn.requestAirdrop(sess.publicKey, 2e9), "confirmed");
const pid = pidToSeed32(`pocrot${Date.now()}@pid`);
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), pid], PROGRAM);
const sessPda = sessionPdaOf(pid, sess.publicKey);
await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: 2 * LAMPORTS_PER_SOL })), [payer], { commitment: "confirmed" }), "confirmed");
{ // activate
  const exp = await liveNow().then(t => t + 300);
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([5]), pid, authO, u16(POLICY_V1), i64(exp)]));
  const s = signPayload(kOwner, h);
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([5]), pid, authO, u16(POLICY_V1), i64(exp), u64(BigInt(ACT_FEE)), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true });
  console.log("vault activated");
}
const mintAuth = Keypair.generate();
const mint = await createMint(conn, payer, mintAuth.publicKey, null, 6);
const sessAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, sessPda, true);
await mintTo(conn, payer, mint, sessAta.address, mintAuth, 500_000n);
const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, userW.publicKey, false);
{ // register session (game = SPL Token itself, immutable loader => evidence = program)
  const nonce = (await conn.getAccountInfo(pda)).data.readBigUInt64LE(4);
  const exp = await liveNow().then(t => t + 300); const expiresAt = await liveNow().then(t => t + 3600);
  const h = sha256(Buffer.concat([DOMAIN_SESSION, Buffer.from([7]), pid, u64(nonce), sess.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), i64(expiresAt), Buffer.from([0]), Buffer.alloc(32), u64(0n), i64(exp)]));
  const s = signPayload(kOwner, h);
  const len = Buffer.alloc(2); len.writeUInt16LE(s.clientDataJSON.length);
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: sessPda, isSigner: false, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([7]), u64(nonce), sess.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), i64(expiresAt), Buffer.from([0]), Buffer.alloc(32), u64(0n), i64(exp), len, s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true });
  console.log("session registered, vault nonce now:", (await conn.getAccountInfo(pda)).data.readBigUInt64LE(4).toString());
}
{ // ROTATE owner O -> N (nonce consumed)
  const nonce = (await conn.getAccountInfo(pda)).data.readBigUInt64LE(4);
  const exp = await liveNow().then(t => t + 300);
  const authN = compressedPub(kNew.publicKey);
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([3]), pid, u64(nonce), authN, i64(exp)]));
  const s = signPayload(kOwner, h);
  const len = Buffer.alloc(2); len.writeUInt16LE(s.clientDataJSON.length);
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([3]), u64(nonce), authN, i64(exp), len, s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true });
  console.log("rotated O->N, vault nonce now:", (await conn.getAccountInfo(pda)).data.readBigUInt64LE(4).toString());
}
// execute gameplay with OLD session key AFTER rotation (seq 0 token transfer 100)
{
  const F = (w, sg) => Buffer.from([((w ? 1 : 0) | (sg ? 2 : 0))]);
  const gameData = Buffer.concat([Buffer.from([3]), u64(100)]);
  const metas = [[sessAta.address.toBuffer(), F(true, false)], [userAta.address.toBuffer(), F(true, false)], [sessPda.toBuffer(), F(false, true)]];
  const metaBytes = Buffer.concat(metas.flatMap(([a, f]) => [a, f]));
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: sessPda, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: sess.publicKey, isSigner: true, isWritable: false }, { pubkey: sessAta.address, isSigner: false, isWritable: true }, { pubkey: userAta.address, isSigner: false, isWritable: true }], programId: PROGRAM, data: Buffer.concat([Buffer.from([8]), u64(0n), u16(gameData.length), gameData, Buffer.from([metas.length]), metaBytes, Buffer.from([0])]) })), [sess], { commitment: "confirmed", skipPreflight: true });
  console.log("SESSION-EXEC-AFTER-ROTATION OK; user balance:", (await conn.getTokenAccountBalance(userAta.address)).value.amount);
  console.log("POC-C DONE: pre-rotation session key still executes after owner rotation (B3 TERBUKTI — no auto-revocation)");
}
