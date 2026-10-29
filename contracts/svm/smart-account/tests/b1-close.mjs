// ANT-866/B1 adversarial suite: PID-key binding + close grace + tombstone.
//
// Runs against an ISOLATED local `solana-test-validator` (dummy fixtures
// only — no mainnet, no user funds). Replays ANT-860 PoC-A (squat +
// close-drain + re-claim) against the fixed program and proves each leg now
// fails or lands harmlessly, plus the full grace flow (request → freeze →
// premature-finalize rejection → cancel recovery) and post-binding rotation.
//
// COVERAGE (each prints PASS/FAIL, non-zero exit on any FAIL):
//  1. V3 bound claim (pre-funded PDA, tombstone account, 112B/v3/key_hash state)
//  2. V4 bound claim (second pid — covers the activate_v4 tombstone path)
//  3. PoC-A replay: attacker self-claim lands on the attacker's PDA;
//     victim pre-fund untouched; second attacker lands on a third PDA
//  4. Grace opens: close_request flips CLOSING, burns the nonce
//  5. Freeze: execute + withdraw + rotate fail AccountClosing inside grace
//  6. Premature finalize fails (GraceNotElapsed); wrong destination fails
//  7. Cancel revives (ACTIVE, ticket rent refunded, spends work again)
//  8. Double request fails (CloseAlreadyRequested); ticketless cancel/finalize fail
//  9. Rotation still works post-binding (stored-hash design): old key dead,
//     new key spends, PDA unchanged
//
// NOT live-provable on a fixed-clock validator (unix_timestamp cannot be
// warped): post-grace finalize success + tombstone reclaim rejection. Those
// legs are covered by host unit tests (`state::ant866_close_flow_tests`,
// `check_close_mature`, ticket/tombstone codecs) and a testnet soak owned by
// Tristan (QA handoff on ANT-866): request → wait 7d → finalize → assert
// tombstone bytes + reclaim rejects Tombstoned.
//
// Usage (isolated ports — never the default 8899/8000 shared validator):
//   export PATH="$HOME/.local/share/solana/install/releases/2.3.13/solana-release/bin:$PATH"
//   cd contracts/svm
//   solana-test-validator --reset --ledger test-ledger-b1 --rpc-port 18999 --gossip-port 18901 &
//   cd smart-account && cargo build-sbf
//   solana program deploy target/deploy/peridot_smart_account.so \
//     --program-id target/deploy/peridot_smart_account-keypair.json --url http://127.0.0.1:18999
//   node tests/b1-close.mjs <program-id> [rpc-url]
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, TransactionInstruction } from "@solana/web3.js";

const PROGRAM = new PublicKey(process.argv[2] || "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT");
const RPC = process.argv[3] || "http://127.0.0.1:18999";
const SECP = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const DOMAIN_V3 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v3");
const DOMAIN_V4 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v4");
const AUTH_PREFIX = crypto.createHash("sha256").update("test-rp").digest();
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const OP = { activate: 5, closeRequest: 33, closeCancel: 34, closeFinalize: 35 };
const POLICY_V1 = 1;
const protocolFeeOf = (net) => (BigInt(net) * 5000n) / 10_000n;

const conn = new Connection(RPC, "confirmed");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const pidToSeed32 = (pid) => sha256(Buffer.from(pid.trim().toLowerCase(), "utf8"));
// ANT-866 B1 derivation mirrors (state.rs): vault seeds bind sha256(authority),
// tombstones are pid-only.
const keyHash = (authComp) => sha256(Buffer.from(authComp));
const vaultPda = (accountId32, authComp) => PublicKey.findProgramAddressSync(
  [Buffer.from("peridot_id"), Buffer.from("account"), accountId32, keyHash(authComp)], PROGRAM)[0];
const tombstonePda = (accountId32) => PublicKey.findProgramAddressSync(
  [Buffer.from("peridot_id"), Buffer.from("tombstone"), accountId32], PROGRAM)[0];
const ticketPda = (accountId32, authComp) => PublicKey.findProgramAddressSync(
  [Buffer.from("peridot_id"), Buffer.from("close"), accountId32, keyHash(authComp)], PROGRAM)[0];
const [TREASURY_PDA] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM);
const [CONFIG_PDA] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM);

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
function authData() { return Buffer.concat([AUTH_PREFIX, Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]); }
function signPayload(keypair, payloadHash) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: b64url(payloadHash), origin: "test.invalid" }));
  const messageData = Buffer.concat([authData(), sha256(clientDataJSON)]);
  const sig = lowS(crypto.sign("sha256", messageData, { key: keypair.privateKey, dsaEncoding: "ieee-p1363" }));
  return { clientDataJSON, messageData, sig, comp: compressedPub(keypair.publicKey) };
}
function buildSecpIx(pubkeyComp, sigRaw, messageData) {
  const o = Buffer.alloc(14);
  o.writeUInt16LE(49, 0); o.writeUInt16LE(0xffff, 2); o.writeUInt16LE(16, 4);
  o.writeUInt16LE(0xffff, 6); o.writeUInt16LE(113, 8);
  o.writeUInt16LE(messageData.length, 10); o.writeUInt16LE(0xffff, 12);
  return new TransactionInstruction({ keys: [], programId: SECP, data: Buffer.concat([Buffer.from([1, 0]), o, pubkeyComp, sigRaw, messageData]) });
}
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };

let passed = 0, failed = 0;
const results = [];
async function expectOk(tx, signers, label) {
  try {
    await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: true });
    results.push(`PASS ${label}`); passed++;
  } catch (e) {
    const logs = await e.getLogs?.().catch(() => null);
    console.error(`LOGS ${label}:`, logs ? logs.join(" | ").slice(0, 600) : String(e.message).slice(0, 300));
    results.push(`FAIL ${label}`); failed++;
  }
}
async function expectErr(tx, signers, label) {
  try {
    await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: true });
    results.push(`FAIL ${label} (expected rejection, tx succeeded)`); failed++;
  } catch { results.push(`PASS ${label}`); passed++; }
}

// ---- instruction builders (mirror close_request.rs / close_cancel.rs / close_finalize.rs) ----
function activateIxV3(accountId32, authorityComp, policy, expiry, networkFee, relayerPub, pda, keypair) {
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.activate]), accountId32, authorityComp, u16(policy), i64(expiry)]));
  const s = signPayload(keypair, h);
  return new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: relayerPub, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: TREASURY_PDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      { pubkey: tombstonePda(accountId32), isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([5]), accountId32, authorityComp, u16(policy), i64(expiry), u64(networkFee), u16(s.clientDataJSON.length), s.clientDataJSON]),
  }), buildSecpIx(s.comp, s.sig, s.messageData));
}
function activateIxV4(accountId32, authorityComp, policy, expiry, networkFee, maxTotalFee, relayerPub, pda, keypair) {
  const h = sha256(Buffer.concat([DOMAIN_V4, Buffer.from([14]), accountId32, authorityComp, u16(policy), u64(maxTotalFee), i64(expiry)]));
  const s = signPayload(keypair, h);
  return new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: relayerPub, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: TREASURY_PDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      { pubkey: tombstonePda(accountId32), isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([14]), accountId32, authorityComp, u16(policy), i64(expiry), u64(networkFee), u64(maxTotalFee), u16(s.clientDataJSON.length), s.clientDataJSON]),
  }), buildSecpIx(s.comp, s.sig, s.messageData));
}
function requestIx(pda, accountId32, destPub, nonce, expiry, keypair) {
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.closeRequest]), accountId32, u64(nonce), destPub.toBuffer(), i64(expiry)]));
  const s = signPayload(keypair, h);
  const ticket = ticketPda(accountId32, s.comp);
  return { tx: new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: ticket, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([OP.closeRequest]), u64(nonce), destPub.toBuffer(), i64(expiry), u16(s.clientDataJSON.length), s.clientDataJSON]),
  }), buildSecpIx(s.comp, s.sig, s.messageData)), ticket };
}
function cancelIx(pda, accountId32, authComp, nonce, expiry, keypair) {
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.closeCancel]), accountId32, u64(nonce), i64(expiry)]));
  const s = signPayload(keypair, h);
  return new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: ticketPda(accountId32, authComp), isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([OP.closeCancel]), u64(nonce), i64(expiry), u16(s.clientDataJSON.length), s.clientDataJSON]),
  }), buildSecpIx(s.comp, s.sig, s.messageData));
}
function finalizeIx(pda, accountId32, authComp, destPub) {
  return new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: ticketPda(accountId32, authComp), isSigner: false, isWritable: true },
      { pubkey: tombstonePda(accountId32), isSigner: false, isWritable: true },
      { pubkey: destPub, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.from([OP.closeFinalize]),
  }));
}
function withdrawIx(pda, accountId32, destPub, nonce, amount, expiry, networkFee, keypair) {
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([1]), accountId32, u64(nonce), u64(amount), destPub.toBuffer(), i64(expiry), u16(POLICY_V1)]));
  const s = signPayload(keypair, h);
  return new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: destPub, isSigner: false, isWritable: true },
      { pubkey: TREASURY_PDA, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([1]), u64(nonce), u64(amount), destPub.toBuffer(), i64(expiry), u16(POLICY_V1), u64(networkFee), u16(s.clientDataJSON.length), s.clientDataJSON]),
  }), buildSecpIx(s.comp, s.sig, s.messageData));
}
function rotateIx(pda, accountId32, nonce, newAuthComp, expiry, keypair) {
  const h = sha256(Buffer.concat([DOMAIN_V3, Buffer.from([3]), accountId32, u64(nonce), newAuthComp, i64(expiry)]));
  const s = signPayload(keypair, h);
  return new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([3]), u64(nonce), newAuthComp, i64(expiry), u16(s.clientDataJSON.length), s.clientDataJSON]),
  }), buildSecpIx(s.comp, s.sig, s.messageData));
}

const payer = Keypair.generate();
const TAG = Date.now().toString(36);
const kv = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const victim = kv(), atkA = kv(), atkB = kv();
const authV = compressedPub(victim.publicKey);
const authA = compressedPub(atkA.publicKey);
const authB = compressedPub(atkB.publicKey);
const NETWORK_FEE = 100_000n;

const liveNow = async () => conn.getBlockTime(await conn.getSlot());
const fund = async (to, lamports) => {
  await conn.confirmTransaction(await sendAndConfirmTransaction(conn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports })),
    [payer], { commitment: "confirmed" }), "confirmed");
};

async function main() {
  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 20e9), "confirmed");
  console.log(`program ${PROGRAM.toBase58()} rpc ${RPC} tag ${TAG}`);
  // Treasury init (idempotent across reruns on one ledger).
  const adminKp = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(adminKp.publicKey, 2e9), "confirmed");
  if (!(await conn.getAccountInfo(CONFIG_PDA))) {
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      keys: [
        { pubkey: adminKp.publicKey, isSigner: true, isWritable: true },
        { pubkey: CONFIG_PDA, isSigner: false, isWritable: true },
        { pubkey: TREASURY_PDA, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: Buffer.concat([Buffer.from([15]), adminKp.publicKey.toBuffer()]),
    })), [adminKp], { commitment: "confirmed", skipPreflight: true });
    console.log("treasury initialized");
  }
  await fund(TREASURY_PDA, 1e9).catch(() => {});

  // ---- 1. V3 bound claim (pre-funded PDA) ----
  const id1 = pidToSeed32(`b1v3-${TAG}@pid`);
  const pda1 = vaultPda(id1, authV);
  await fund(pda1, 2e9);
  await expectOk(activateIxV3(id1, authV, POLICY_V1, await liveNow().then((t) => t + 300), NETWORK_FEE, payer.publicKey, pda1, victim),
    [payer], "V3 bound claim activates pre-funded PDA");
  {
    const st = await conn.getAccountInfo(pda1);
    assert.equal(st.data.length, 112, "V3 state is 112 bytes");
    assert.equal(st.data[0], 3, "version 3");
    assert.ok(Buffer.from(st.data.subarray(12, 45)).equals(authV), "authority stored");
    assert.ok(Buffer.from(st.data.subarray(48, 80)).equals(id1), "account_id stored");
    assert.ok(Buffer.from(st.data.subarray(80, 112)).equals(keyHash(authV)), "claim-time key hash stored");
    results.push("PASS V3 bound state layout"); passed++;
  }

  // ---- 2. V4 bound claim (second pid) ----
  const id2 = pidToSeed32(`b1v4-${TAG}@pid`);
  const pda2 = vaultPda(id2, authV);
  await fund(pda2, 2e9);
  const maxFee = NETWORK_FEE + protocolFeeOf(NETWORK_FEE);
  await expectOk(activateIxV4(id2, authV, POLICY_V1, await liveNow().then((t) => t + 300), NETWORK_FEE, maxFee, payer.publicKey, pda2, victim),
    [payer], "V4 bound claim activates pre-funded PDA");

  // ---- 3. PoC-A replay: squat + close-drain + re-claim, all neutered ----
  const idV = pidToSeed32(`b1poc-${TAG}@pid`);
  const pdaV = vaultPda(idV, authV);
  const pdaA = vaultPda(idV, authA);
  const pdaB = vaultPda(idV, authB);
  assert.notEqual(pdaA.toBase58(), pdaV.toBase58(), "attacker key derives a different PDA");
  assert.notEqual(pdaB.toBase58(), pdaV.toBase58(), "second attacker derives a third PDA");
  await fund(pdaV, 1e9);
  const victimBefore = (await conn.getAccountInfo(pdaV)).lamports;
  await fund(pdaA, 1e9);
  await expectOk(activateIxV3(idV, authA, POLICY_V1, await liveNow().then((t) => t + 300), NETWORK_FEE, payer.publicKey, pdaA, atkA),
    [payer], "attacker self-claim lands on attacker PDA (permissionless, harmless)");
  {
    const v = await conn.getAccountInfo(pdaV);
    assert.equal(v.lamports, victimBefore, "victim pre-fund untouched");
    assert.equal(v.owner.toBase58(), SystemProgram.programId.toBase58(), "victim PDA still system-owned");
    const a = await conn.getAccountInfo(pdaA);
    assert.ok(Buffer.from(a.data.subarray(12, 45)).equals(authA), "attacker authority stored on attacker account");
    results.push("PASS PoC-A squat neutered (counterfactual funding safe)"); passed++;
  }
  // Second attacker re-claims the same pid: lands on THEIR PDA (no tombstone —
  // the victim never closed; each key owns its own vault).
  await fund(pdaB, 1e9);
  await expectOk(activateIxV3(idV, authB, POLICY_V1, await liveNow().then((t) => t + 300), NETWORK_FEE, payer.publicKey, pdaB, atkB),
    [payer], "second attacker lands on a third PDA (no shared-vault squat)");
  assert.equal((await conn.getAccountInfo(pdaV)).lamports, victimBefore, "victim pre-fund still untouched");

  // ---- 4. grace opens: request freezes the vault, burns the nonce ----
  const dest = Keypair.generate();
  let nonce = 0n;
  const { tx: reqTx } = requestIx(pda1, id1, dest.publicKey, nonce, await liveNow().then((t) => t + 300), victim);
  await expectOk(reqTx, [payer], "close_request opens grace (CLOSING)");
  {
    const st = await conn.getAccountInfo(pda1);
    assert.equal(st.data[2], 2, "status = CLOSING");
    assert.equal(st.data.readBigUInt64LE(4), 1n, "nonce consumed by request");
    const ticket = await conn.getAccountInfo(ticketPda(id1, authV));
    assert.ok(ticket && ticket.data.length === 107, "ticket created (107 bytes)");
    assert.ok(Buffer.from(ticket.data.subarray(66, 98)).equals(dest.publicKey.toBuffer()), "ticket binds destination");
    results.push("PASS grace opens with bound destination"); passed++;
  }
  nonce = 1n;

  // ---- 5. freeze: spends fail AccountClosing inside grace ----
  await expectErr(withdrawIx(pda1, id1, dest.publicKey, nonce, 1_000_000, await liveNow().then((t) => t + 300), 0n, victim),
    [payer], "withdraw frozen during grace (AccountClosing)");
  await expectErr(rotateIx(pda1, id1, nonce, authA, await liveNow().then((t) => t + 300), victim),
    [payer], "rotation frozen during grace (AccountClosing)");

  // ---- 6. premature finalize fails; wrong destination fails ----
  await expectErr(finalizeIx(pda1, id1, authV, dest.publicKey), [payer], "premature finalize rejected (GraceNotElapsed)");
  await expectErr(finalizeIx(pda1, id1, authV, payer.publicKey), [payer], "finalize with wrong destination rejected (InvalidDestination)");

  // ---- 7. cancel revives: ACTIVE, ticket rent refunded, spends work ----
  const balBefore = (await conn.getAccountInfo(pda1)).lamports;
  const { tx: cancelTx } = { tx: cancelIx(pda1, id1, authV, nonce, await liveNow().then((t) => t + 300), victim) };
  await expectOk(cancelTx, [payer], "close_cancel revives the vault");
  {
    const st = await conn.getAccountInfo(pda1);
    assert.equal(st.data[2], 0, "status back to ACTIVE");
    assert.equal(st.data.readBigUInt64LE(4), 2n, "nonce consumed by cancel");
    assert.ok((await conn.getAccountInfo(pda1)).lamports > balBefore, "ticket rent refunded into vault");
    assert.equal(await conn.getAccountInfo(ticketPda(id1, authV)), null, "ticket deleted");
    results.push("PASS cancel recovery (funds intact, ticket gone)"); passed++;
  }
  nonce = 2n;
  await expectOk(withdrawIx(pda1, id1, dest.publicKey, nonce, 1_000_000, await liveNow().then((t) => t + 300), 0n, victim),
    [payer], "withdraw works again after cancel");
  nonce = 3n;

  // ---- 8. double request fails; ticketless cancel/finalize fail ----
  {
    const r1 = requestIx(pda1, id1, dest.publicKey, nonce, await liveNow().then((t) => t + 300), victim);
    await expectOk(r1.tx, [payer], "second grace opens (nonce advances)");
    await expectErr(requestIx(pda1, id1, dest.publicKey, nonce + 1n, await liveNow().then((t) => t + 300), victim).tx,
      [payer], "double request rejected (CloseAlreadyRequested)");
    const { tx: c2 } = { tx: cancelIx(pda1, id1, authV, nonce + 1n, await liveNow().then((t) => t + 300), victim) };
    await expectOk(c2, [payer], "second grace cancelled");
    nonce += 2n;
  }
  {
    // Fresh vault, never requested: cancel + finalize find no ticket.
    const idF = pidToSeed32(`b1fresh-${TAG}@pid`);
    const pdaF = vaultPda(idF, authV);
    await fund(pdaF, 2e9);
    await expectOk(activateIxV3(idF, authV, POLICY_V1, await liveNow().then((t) => t + 300), NETWORK_FEE, payer.publicKey, pdaF, victim),
      [payer], "fresh vault claimed");
    await expectErr(cancelIx(pdaF, idF, authV, 0n, await liveNow().then((t) => t + 300), victim),
      [payer], "ticketless cancel rejected (CloseTicketNotFound)");
    await expectErr(finalizeIx(pdaF, idF, authV, dest.publicKey), [payer], "ticketless finalize rejected (CloseTicketNotFound)");
  }

  // ---- 9. rotation still works post-binding (stored-hash design) ----
  await expectOk(rotateIx(pda1, id1, nonce, authA, await liveNow().then((t) => t + 300), victim),
    [payer], "rotation to new key succeeds on bound vault");
  {
    const st = await conn.getAccountInfo(pda1);
    assert.ok(Buffer.from(st.data.subarray(12, 45)).equals(authA), "new authority stored");
    assert.ok(Buffer.from(st.data.subarray(80, 112)).equals(keyHash(authV)), "claim-time hash UNCHANGED by rotation");
    results.push("PASS rotation preserves binding (stored hash stable)"); passed++;
  }
  nonce += 1n;
  await expectErr(withdrawIx(pda1, id1, dest.publicKey, nonce, 1_000_000, await liveNow().then((t) => t + 300), 0n, victim),
    [payer], "old key dead after rotation (Unauthorized)");
  await expectOk(withdrawIx(pda1, id1, dest.publicKey, nonce, 1_000_000, await liveNow().then((t) => t + 300), 0n, atkA),
    [payer], "new key spends after rotation (binding intact)");

  console.log(results.join("\n"));
  console.log(`B1-CLOSE DONE: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
