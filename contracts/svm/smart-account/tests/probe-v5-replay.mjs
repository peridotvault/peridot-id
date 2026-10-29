// ANT-868 B4 probe: V5 cluster binding across two isolated validators.
// (ANT-863 B2 addendum: V3 is hard-closed on-chain, so the baseline below is
// V4 — setup activates via V4, Part 1 shows V3 rejected on both clusters while
// the identical V4 assertion settles on both.)
//
// Part 1 (B2 baseline): one V3 withdraw assertion is REJECTED on both clusters
//   (V3Deprecated — hard close, NOT a regression); the identical V4 withdraw
//   settles on both (TTL-only bound — the sunset rationale for V5).
// Part 2 (V5 fix): one V5 rotate assertion (disc 20) settles on cluster A;
//   the IDENTICAL bytes submitted to cluster B MUST fail (InvalidChallenge:
//   B recomputes program‖clusterB != signed program‖clusterA). A fresh V5
//   assertion bound to B settles on B (control: B is healthy, binding is
//   cluster-specific — not "V5 is broken").
//
// Setup (run once per probe):
//   export PATH="$HOME/.local/share/solana/install/releases/2.3.13/solana-release/bin:$PATH"
//   solana-test-validator --reset --rpc-port 18999 --gossip-port 18901 ... (cluster A)
//   solana-test-validator --reset --rpc-port 19999 --gossip-port 19901 ... (cluster B)
//   solana program deploy progA.so --program-id prog.json --url http://127.0.0.1:18999
//   solana program deploy progB.so --program-id prog.json --url http://127.0.0.1:19999
//   PID_PROGRAM_ID=<prog-pubkey> PID_CLUSTER_A=<idA> PID_CLUSTER_B=<idB> node tests/probe-v5-replay.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, TransactionInstruction, LAMPORTS_PER_SOL } from "@solana/web3.js";

const PROGRAM = new PublicKey(process.env.PID_PROGRAM_ID ?? "2GYEaGkaPMBuWzrjxVUPzNajyF2oFMUdm2f4HLmPS2Nx");
const CLUSTER_A = Buffer.from(new PublicKey(process.env.PID_CLUSTER_A ?? "H4Hq8g1cZxfMxsGB4xsbCdLWtPvQgKunVCnXN75e2P1D").toBytes());
const CLUSTER_B = Buffer.from(new PublicKey(process.env.PID_CLUSTER_B ?? "f164ncRkhc7LGh9bYD3C8BTqkhAjgbUA3SA6rJ1g599").toBytes());
const SECP = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const DOMAIN_V3 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v3");
const DOMAIN_V4 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v4");
const DOMAIN_V5 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v5");
const AUTH_PREFIX = crypto.createHash("sha256").update("test-rp").digest();
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const POLICY_V1 = 1;
const A = new Connection(process.env.RPC_A ?? "http://127.0.0.1:18999", "confirmed");
const B = new Connection(process.env.RPC_B ?? "http://127.0.0.1:19999", "confirmed");
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
const kNewA = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authNewA = compressedPub(kNewA.publicKey);
const kNewB = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const authNewB = compressedPub(kNewB.publicKey);
const pid = pidToSeed32("probev5replay@pid");
// ANT-866 B1: vault PDA commits to the claiming key; activate carries the (absent) tombstone.
const keyHash = (authComp) => sha256(Buffer.from(authComp));
const [pda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), pid, keyHash(authV)], PROGRAM);
const [tombstone] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("tombstone"), pid], PROGRAM);

async function setup(conn) {
  const payer = Keypair.generate(); const dest = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 20e9), "confirmed");
  const admin = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(admin.publicKey, 2e9), "confirmed");
  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: CONFIG_PDA, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([15]), admin.publicKey.toBuffer()]) })), [admin], { commitment: "confirmed", skipPreflight: true });
  } catch {}
  await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: 2 * LAMPORTS_PER_SOL })), [payer], { commitment: "confirmed" }), "confirmed");
  // ANT-863 B2: setup activates via the fee-capped V4 sibling (V3 activate is
  // hard-closed). maxTotalFee 0 covers the zero attested fee.
  const tA = await conn.getBlockTime(await conn.getSlot());
  const h = sha256(Buffer.concat([DOMAIN_V4, Buffer.from([14]), pid, authV, u16(POLICY_V1), u64(0n), i64(tA + 300)]));
  const s = signPayload(kV, h);
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }, { pubkey: tombstone, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([14]), pid, authV, u16(POLICY_V1), i64(tA + 300), u64(0n), u64(0n), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [payer], { commitment: "confirmed", skipPreflight: true });
  await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: 2 * LAMPORTS_PER_SOL })), [payer], { commitment: "confirmed" }), "confirmed");
  return { payer, dest };
}

const a = await setup(A); const b = await setup(B);
console.log("setup: same PDA activated under same key on both clusters");

// ---- Part 1: V3 withdraw rejected on both (B2 hard close); V4 settles both ----
{
  const t0 = await A.getBlockTime(await A.getSlot());
  const exp = t0 + 300;
  const destBytes = a.dest.publicKey.toBuffer();
  const AMOUNT = BigInt(0.2 * LAMPORTS_PER_SOL);
  // V3 shape (must reject with V3Deprecated on both clusters).
  const v3payload = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([1]), pid, u64(0n), u64(AMOUNT), destBytes, i64(exp), u16(POLICY_V1)]));
  const v3s = signPayload(kV, v3payload);
  async function submitV3(conn, relayer) {
    return sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: new PublicKey(destBytes), isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: relayer.publicKey, isSigner: true, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([1]), u64(0n), u64(AMOUNT), destBytes, i64(exp), u16(POLICY_V1), u64(100_000n), u16(v3s.clientDataJSON.length), v3s.clientDataJSON]) }), buildSecpIx(v3s.comp, v3s.sig, v3s.messageData)), [relayer], { commitment: "confirmed", skipPreflight: true });
  }
  for (const [conn, relayer, tag] of [[A, a.payer, "PART1-A"], [B, b.payer, "PART1-B"]]) {
    let rejected = false;
    try { await submitV3(conn, relayer); } catch { rejected = true; }
    assert(rejected, `PROBE FAILED: V3 withdraw settled on ${tag} — hard close is broken`);
    console.log(`${tag}: V3 withdraw nonce0 REJECTED (hard close holds)`);
  }
  // V4 shape (TTL-only bound — the new cross-cluster baseline): the identical
  // assertion settles on both clusters (V4 binds no cluster).
  const NET = 100_000n, MAX = 150_000n;
  const payload = sha256(Buffer.concat([DOMAIN_V4, Buffer.from([11]), pid, u64(0n), u64(AMOUNT), destBytes, i64(exp), u16(POLICY_V1), u64(MAX)]));
  const s = signPayload(kV, payload);
  async function submitSame(conn, relayer) {
    return sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({ keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: new PublicKey(destBytes), isSigner: false, isWritable: true }, { pubkey: TREASURY_PDA, isSigner: false, isWritable: true }, { pubkey: relayer.publicKey, isSigner: true, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }], programId: PROGRAM, data: Buffer.concat([Buffer.from([11]), u64(0n), u64(AMOUNT), destBytes, i64(exp), u16(POLICY_V1), u64(NET), u64(MAX), u16(s.clientDataJSON.length), s.clientDataJSON]) }), buildSecpIx(s.comp, s.sig, s.messageData)), [relayer], { commitment: "confirmed", skipPreflight: true });
  }
  await submitSame(A, a.payer); console.log("PART1-A: V4 withdraw nonce0 settled on A");
  await submitSame(B, b.payer); console.log("PART1-B: V4 withdraw nonce0 settled on B (same assertion — TTL-only baseline)");
}

// ---- Part 2: V5 rotate settles on A, MUST fail on B ----
function v5RotatePayload(cluster, nonce, newAuth, expiry) {
  return sha256(Buffer.concat([
    DOMAIN_V5, Buffer.from([20]), PROGRAM.toBytes(), cluster, pid, u64(nonce), newAuth, i64(expiry),
  ]));
}
async function submitV5Rotate(conn, relayer, newAuth, cluster, nonce, sig) {
  const t = await conn.getBlockTime(await conn.getSlot());
  void t;
  const expiry = sig.expiry;
  return sendAndConfirmTransaction(conn, new Transaction().add(
    new TransactionInstruction({
      keys: [{ pubkey: pda, isSigner: false, isWritable: true }, { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false }],
      programId: PROGRAM,
      data: Buffer.concat([Buffer.from([20]), u64(nonce), newAuth, i64(expiry), u16(sig.clientDataJSON.length), sig.clientDataJSON]),
    }),
    buildSecpIx(sig.comp, sig.sig, sig.messageData),
  ), [relayer], { commitment: "confirmed", skipPreflight: true });
}
{
  const t0 = await A.getBlockTime(await A.getSlot());
  const exp = t0 + 300;
  // V5 rotate bound to cluster A, vault nonce 1 (Part 1 consumed nonce 0 on both).
  const payloadA = v5RotatePayload(CLUSTER_A, 1n, authNewA, exp);
  const sA = { ...signPayload(kV, payloadA), expiry: exp };
  await submitV5Rotate(A, a.payer, authNewA, CLUSTER_A, 1n, sA);
  console.log("PART2-A: V5 rotate nonce1 settled on A");

  // IDENTICAL bytes on B must fail.
  let failed = false;
  try {
    await submitV5Rotate(B, b.payer, authNewA, CLUSTER_A, 1n, sA);
  } catch (e) {
    failed = true;
    console.log("PART2-B: V5 rotate (A-bound) REJECTED on B as required:", String(e).split("\n")[0].slice(0, 160));
  }
  assert(failed, "PROBE FAILED: A-bound V5 assertion settled on B — cluster binding is broken");

  // Control: a B-bound V5 rotate settles on B (B is healthy; binding is specific).
  const payloadB = v5RotatePayload(CLUSTER_B, 1n, authNewB, exp);
  const sB = { ...signPayload(kV, payloadB), expiry: exp };
  await submitV5Rotate(B, b.payer, authNewB, CLUSTER_B, 1n, sB);
  console.log("PART2-C: V5 rotate (B-bound) nonce1 settled on B — control passes");
}
console.log("PROBE-V5 DONE: V5 cluster binding holds (A-assertion dies on B, B-assertion lives on B)");
