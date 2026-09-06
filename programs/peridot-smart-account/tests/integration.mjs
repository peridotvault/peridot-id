// PeridotID smart-account program — integration test suite (task 005).
//
// Runs against a local `solana-test-validator`. Covers the PRD_v4 §27 adversarial list for
// the secp256r1 passkey authority (ADR 005 Option B, Tier B):
//   initialize / valid & invalid authorization / invalid nonce / replay / unauthorized
//   transfer / authority rotation / malformed instruction / account (PDA) mismatch.
//
// Usage:
//   solana-test-validator --reset > /tmp/validator.log 2>&1 &
//   node tests/integration.mjs <program-id>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, TransactionInstruction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const PROGRAM = new PublicKey(process.argv[2] || "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT");
const SECP = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const DOMAIN = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v1");
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);
const uuidTo32 = (uuid) => Buffer.concat([Buffer.alloc(16), Buffer.from(uuid.replace(/-/g, ""), "hex")]);

function lowS(sig) {
  const r = BigInt("0x" + sig.subarray(0, 32).toString("hex"));
  let s = BigInt("0x" + sig.subarray(32).toString("hex"));
  if (s > N / 2n) s = N - s;
  const buf = Buffer.alloc(64);
  Buffer.from(r.toString(16).padStart(64, "0"), "hex").copy(buf, 0);
  Buffer.from(s.toString(16).padStart(64, "0"), "hex").copy(buf, 32);
  return buf;
}

function compressedPub(pub) {
  const der = pub.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 65);
  const X = raw.subarray(1, 33);
  return Buffer.concat([Buffer.from([(raw[64] & 1) ? 0x03 : 0x02]), X]);
}

function buildPayload(nonce, amount, destBytes, expiry, relayFee = 0n) {
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  const ab = Buffer.alloc(8); ab.writeBigUInt64LE(BigInt(amount));
  const eb = Buffer.alloc(8); eb.writeBigInt64LE(BigInt(expiry));
  const fb = Buffer.alloc(8); fb.writeBigUInt64LE(BigInt(relayFee));
  return sha256(Buffer.concat([DOMAIN, nb, ab, destBytes, eb, fb]));
}

function makeAssertion(payloadHash) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: b64url(payloadHash), origin: "https://peridot-id.example",
  }));
  const authenticatorData = Buffer.alloc(37);
  authenticatorData.writeUInt32BE(1, 33);
  return { clientDataJSON, messageData: Buffer.concat([authenticatorData, sha256(clientDataJSON)]) };
}

function buildSecpIx(pubkeyComp, sigRaw, messageData) {
  const o = Buffer.alloc(14);
  o.writeUInt16LE(49, 0); o.writeUInt16LE(0xffff, 2);
  o.writeUInt16LE(16, 4); o.writeUInt16LE(0xffff, 6);
  o.writeUInt16LE(113, 8); o.writeUInt16LE(messageData.length, 10); o.writeUInt16LE(0xffff, 12);
  return new TransactionInstruction({
    keys: [], programId: SECP,
    data: Buffer.concat([Buffer.from([1, 0]), o, pubkeyComp, sigRaw, messageData]),
  });
}

function wdData(disc, fields, clientDataJSON) {
  const lenB = Buffer.alloc(2); lenB.writeUInt16LE(clientDataJSON.length);
  return Buffer.concat([Buffer.from([disc]), ...fields, lenB, clientDataJSON]);
}

// disc=1 sponsored withdraw_sol: nonce, amount, dest, expiry, relay_fee. Accounts include
// the treasury (receives the reimbursed relay fee) and the relayer (tx signer / fee payer).
function withdrawIx(pda, destPub, treasuryPub, relayerPub, nonce, amount, destBytes, relayFee, expiry, keypair, assertion) {
  const payload = buildPayload(nonce, amount, destBytes, expiry, relayFee);
  const sig = lowS(crypto.sign("sha256", assertion.messageData, { key: keypair.privateKey, dsaEncoding: "ieee-p1363" }));
  const comp = compressedPub(keypair.publicKey);
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  const ab = Buffer.alloc(8); ab.writeBigUInt64LE(BigInt(amount));
  const eb = Buffer.alloc(8); eb.writeBigInt64LE(BigInt(expiry));
  const fb = Buffer.alloc(8); fb.writeBigUInt64LE(BigInt(relayFee));
  const programIx = new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: destPub, isSigner: false, isWritable: true },
      { pubkey: treasuryPub, isSigner: false, isWritable: true },
      { pubkey: relayerPub, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: wdData(1, [nb, ab, destBytes, eb, fb], assertion.clientDataJSON),
  });
  return new Transaction().add(programIx, buildSecpIx(comp, sig, assertion.messageData));
}

// disc=3 update_authority: nonce, new_authority(33), expiry
function updateAuthIx(pda, nonce, newAuth, expiry, keypair, assertion) {
  const payload = sha256(Buffer.concat([DOMAIN,
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(nonce)); return b; })(),
    newAuth,
    (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(expiry)); return b; })(),
  ]));
  const sig = lowS(crypto.sign("sha256", assertion.messageData, { key: keypair.privateKey, dsaEncoding: "ieee-p1363" }));
  const comp = compressedPub(keypair.publicKey);
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  const eb = Buffer.alloc(8); eb.writeBigInt64LE(BigInt(expiry));
  const programIx = new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: wdData(3, [nb, newAuth, eb], assertion.clientDataJSON),
  });
  return new Transaction().add(programIx, buildSecpIx(comp, sig, assertion.messageData));
}

let passed = 0;
let failed = 0;
const results = [];

async function expectOk(tx, signers, label) {
  try {
    await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: true });
    results.push(`PASS ${label}`); passed++;
  } catch (e) {
    const logs = await e.getLogs?.().catch(() => null);
    const errLine = logs?.find(l => l.includes("failed:") || l.includes("custom program error"));
    results.push(`FAIL ${label}: ${errLine || String(e.message).split("\n")[0]}`); failed++;
  }
}

async function expectErr(tx, signers, label) {
  try {
    await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: true });
    results.push(`FAIL ${label} (expected rejection, tx succeeded)`); failed++;
  } catch {
    results.push(`PASS ${label}`); passed++;
  }
}

// disc=5 activate: account_id(32) | authority(33) | activation_fee u64
function activateIx(accountId32, authorityComp, activationFee, relayerPub, pda, treasuryPub) {
  const fee = Buffer.alloc(8); fee.writeBigUInt64LE(BigInt(activationFee));
  return new TransactionInstruction({
    keys: [
      { pubkey: relayerPub, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: treasuryPub, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([5]), accountId32, authorityComp, fee]),
  });
}

async function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const authorityComp = compressedPub(publicKey);
  const { privateKey: k2, publicKey: p2 } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  const rentPayer = Keypair.generate();
  const dest = Keypair.generate();
  const treasury = Keypair.generate();
  const RELAY_FEE = 100_000n;
  await conn.confirmTransaction(await conn.requestAirdrop(rentPayer.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
  await conn.confirmTransaction(await conn.requestAirdrop(dest.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  // Treasury must be rent-exempt: direct lamport writes to a non-existent account are rejected.
  await conn.confirmTransaction(await conn.requestAirdrop(treasury.publicKey, LAMPORTS_PER_SOL), "confirmed");

  const vclock = await conn.getBlockTime(await conn.getSlot());
  const now = () => vclock;
  const accountId32 = uuidTo32(crypto.randomBytes(16).toString("hex"));
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("peridot_id"), Buffer.from("account"), accountId32], PROGRAM);
  console.log(`program ${PROGRAM.toBase58()} pda ${pda.toBase58()} bump ${bump}`);

  // ---- initialize ----
  const initData = Buffer.concat([Buffer.from([0]), accountId32, authorityComp]);
  const initIx = new TransactionInstruction({
    keys: [
      { pubkey: rentPayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM, data: initData,
  });
  await expectOk(new Transaction().add(initIx), [rentPayer], "initialize");

  const acct = await conn.getAccountInfo(pda);
  assert.equal(acct.data.length, 80, "state len 80");
  assert.equal(acct.data[1], 1, "authority_type = secp256r1");
  assert.equal(acct.data.readBigUInt64LE(4), 0n, "nonce = 0");
  assert.equal(acct.data.slice(12, 45).equals(authorityComp), true, "authority stored");
  results.push("PASS state layout");

  // ---- initialize again → AlreadyInitialized ----
  await expectErr(new Transaction().add(initIx), [rentPayer], "re-initialize rejected");

  // ---- activate: Peridot-sponsored claim + reimbursement (disc 5) ----
  {
    const actId = uuidTo32(crypto.randomBytes(16).toString("hex"));
    const [actPda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), actId], PROGRAM);
    const relayer = Keypair.generate();
    const treasury = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(relayer.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");

    // Pre-fund the PDA (the user's deposit) more than enough to cover activation.
    const funded = 150_000_000; // 0.15 SOL
    await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: rentPayer.publicKey, toPubkey: actPda, lamports: funded })
    ), [rentPayer], { commitment: "confirmed" }), "confirmed");

    const beforeTreasury = (await conn.getAccountInfo(treasury.publicKey))?.lamports ?? 0;
    const activationFee = 1_592_460;
    await expectOk(new Transaction().add(
      activateIx(actId, authorityComp, activationFee, relayer.publicKey, actPda, treasury.publicKey)
    ), [relayer], "activate claims PDA and reimburses treasury");

    const claimed = await conn.getAccountInfo(actPda);
    assert.ok(claimed, "activate created on-chain account");
    assert.equal(claimed.data.length, 80, "activate wrote 80-byte state");
    assert.equal(claimed.owner.toBase58(), PROGRAM.toBase58(), "activate transferred ownership to program");
    // Fee moved out of the PDA to the treasury; deposit minus fee remains.
    assert.equal(claimed.lamports, funded - activationFee, "activation fee reimbursed out of PDA");
    const afterTreasury = (await conn.getAccountInfo(treasury.publicKey))?.lamports ?? 0;
    assert.equal(afterTreasury - beforeTreasury, activationFee, "treasury received the activation fee");
    results.push("PASS activate state + reimbursement");
  }

  // ---- activate an already-initialized account → rejected ----
  await expectErr(new Transaction().add(
    activateIx(accountId32, authorityComp, 1000, rentPayer.publicKey, pda, dest.publicKey)
  ), [rentPayer], "activate on initialized account rejected");

  // ---- deposit (plain transfer) ----
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: rentPayer.publicKey, toPubkey: pda, lamports: 10_000_000 })
  ), [rentPayer], { commitment: "confirmed" });

  // ---- withdraw: valid (relayer-sponsored) — dest gets amount, treasury gets relay_fee ----
  const destBytes = dest.publicKey.toBuffer();
  const expiry = now() + 3600;
  const treasury0 = (await conn.getAccountInfo(treasury.publicKey))?.lamports ?? 0;
  const a = makeAssertion(buildPayload(0, 5_000_000, destBytes, expiry, RELAY_FEE));
  await expectOk(withdrawIx(pda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 0, 5_000_000, destBytes, RELAY_FEE, expiry, { privateKey, publicKey }, a), [rentPayer], "withdraw valid");
  const treasury1 = (await conn.getAccountInfo(treasury.publicKey))?.lamports ?? 0;
  assert.equal(treasury1 - treasury0, Number(RELAY_FEE), "relay fee reimbursed to treasury");
  results.push("PASS relay fee reimbursed");

  // ---- unauthorized transfer (wrong passkey) ----
  const a1 = makeAssertion(buildPayload(1, 1_000_000, destBytes, expiry, RELAY_FEE));
  await expectErr(withdrawIx(pda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, RELAY_FEE, expiry, { privateKey: k2, publicKey: p2 }, a1), [rentPayer], "unauthorized passkey rejected");

  // ---- invalid nonce / replay ----
  const a2 = makeAssertion(buildPayload(0, 1_000_000, destBytes, expiry, RELAY_FEE));
  await expectErr(withdrawIx(pda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 0, 1_000_000, destBytes, RELAY_FEE, expiry, { privateKey, publicKey }, a2), [rentPayer], "replay (nonce 0) rejected");

  const a3 = makeAssertion(buildPayload(99, 1_000_000, destBytes, expiry, RELAY_FEE));
  await expectErr(withdrawIx(pda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 99, 1_000_000, destBytes, RELAY_FEE, expiry, { privateKey, publicKey }, a3), [rentPayer], "invalid nonce rejected");

  // ---- expired expiry ----
  const a4 = makeAssertion(buildPayload(1, 1_000_000, destBytes, now() - 60, RELAY_FEE));
  await expectErr(withdrawIx(pda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, RELAY_FEE, now() - 60, { privateKey, publicKey }, a4), [rentPayer], "expired expiry rejected");

  // ---- transaction substitution (challenge binds amount X, executes Y) ----
  const a5 = makeAssertion(buildPayload(1, 1_000_000, destBytes, expiry, RELAY_FEE));
  await expectErr(withdrawIx(pda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 1, 9_000_000, destBytes, RELAY_FEE, expiry, { privateKey, publicKey }, a5), [rentPayer], "challenge/args mismatch rejected");

  // ---- account mismatch (wrong PDA in args vs actual) ----
  const otherId = uuidTo32(crypto.randomBytes(16).toString("hex"));
  const [otherPda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), otherId], PROGRAM);
  const a6 = makeAssertion(buildPayload(1, 1_000_000, destBytes, expiry, RELAY_FEE));
  await expectErr(withdrawIx(otherPda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, RELAY_FEE, expiry, { privateKey, publicKey }, a6), [rentPayer], "account (PDA) mismatch rejected");

  // ---- malformed instruction (truncated clientDataJSON length) ----
  const malformed = new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: dest.publicKey, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), // too short
  });
  await expectErr(new Transaction().add(malformed), [rentPayer], "malformed instruction rejected");

  // ---- authority rotation: valid + unauthorized ----
  const newAuth = compressedPub(p2);
  const ra = makeAssertion(sha256(Buffer.concat([DOMAIN,
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(1n); return b; })(),
    newAuth,
    (() => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(expiry)); return b; })(),
  ])));
  await expectOk(updateAuthIx(pda, 1, newAuth, expiry, { privateKey, publicKey }, ra), [rentPayer], "update_authority valid");

  // Now the OLD key must be rejected, the NEW key accepted.
  const a7 = makeAssertion(buildPayload(2, 1_000_000, destBytes, expiry, RELAY_FEE));
  await expectErr(withdrawIx(pda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 2, 1_000_000, destBytes, RELAY_FEE, expiry, { privateKey, publicKey }, a7), [rentPayer], "old authority rejected after rotation");

  const a8 = makeAssertion(buildPayload(2, 1_000_000, destBytes, expiry, RELAY_FEE));
  await expectOk(withdrawIx(pda, dest.publicKey, treasury.publicKey, rentPayer.publicKey, 2, 1_000_000, destBytes, RELAY_FEE, expiry, { privateKey: k2, publicKey: p2 }, a8), [rentPayer], "new authority accepted after rotation");

  // ---- sponsored token withdraw (disc 2) — tokens move via SPL CPI, relay fee reimbursed ----
  {
    const TOKEN_PROG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const mintAuth = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(mintAuth.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const mint = await createMint(conn, mintAuth, mintAuth.publicKey, null, 6);
    const smartToken = await getOrCreateAssociatedTokenAccount(conn, mintAuth, mint, pda, true);
    const destToken = await getOrCreateAssociatedTokenAccount(conn, mintAuth, mint, dest.publicKey);
    await mintTo(conn, mintAuth, mint, smartToken.address, mintAuth, 10_000_000);
    results.push("PASS token ATA + mint");
    // nonce is 3 (after the two rotation withdraws).
    const ttRelay = 100_000n;
    const ttAmount = 2_000_000n;
    const tokenAtaBytes = destToken.address.toBuffer();
    const ttExpiry = now() + 3600;
    const ttAssertion = makeAssertion(buildPayload(3, ttAmount, tokenAtaBytes, ttExpiry, ttRelay));
    const ttSig = lowS(crypto.sign("sha256", ttAssertion.messageData, { key: k2, dsaEncoding: "ieee-p1363" }));
    const ttComp = compressedPub(p2);
    const nb = Buffer.alloc(8); nb.writeBigUInt64LE(3n);
    const ab = Buffer.alloc(8); ab.writeBigUInt64LE(ttAmount);
    const eb = Buffer.alloc(8); eb.writeBigInt64LE(BigInt(ttExpiry));
    const fb = Buffer.alloc(8); fb.writeBigUInt64LE(ttRelay);
    const tokenIx = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: smartToken.address, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destToken.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROG, isSigner: false, isWritable: false },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
        { pubkey: treasury.publicKey, isSigner: false, isWritable: true },
        { pubkey: rentPayer.publicKey, isSigner: true, isWritable: true },
      ],
      programId: PROGRAM,
      data: wdData(2, [nb, ab, tokenAtaBytes, eb, fb], ttAssertion.clientDataJSON),
    });
    const treasuryBefore = (await conn.getAccountInfo(treasury.publicKey))?.lamports ?? 0;
    await expectOk(new Transaction().add(tokenIx, buildSecpIx(ttComp, ttSig, ttAssertion.messageData)), [rentPayer], "sponsored withdraw token valid");
    const smartBal = (await conn.getTokenAccountBalance(smartToken.address)).value.uiAmount;
    const destBal = (await conn.getTokenAccountBalance(destToken.address)).value.uiAmount;
    assert.equal(smartBal, 8, "smart ATA debited by token amount");
    assert.equal(destBal, 2, "dest ATA credited");
    const treasuryAfter = (await conn.getAccountInfo(treasury.publicKey))?.lamports ?? 0;
    assert.equal(treasuryAfter - treasuryBefore, Number(ttRelay), "token withdraw relay fee reimbursed");
    results.push("PASS token withdraw state + relay fee");
  }

  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("INTEGRATION OK");
}
main().catch((e) => { console.log(results.join("\n")); console.error("FAIL", e); process.exit(1); });