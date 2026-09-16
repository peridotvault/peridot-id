// PeridotID smart-account program — V3 integration suite.
//
// Runs against a local `solana-test-validator`. Covers the V3 authorization + fee
// schema (contracts/V2_AUTHORIZATION.md, canonical): op-tagged + account-bound
// payloads with policy-only fee binding, attested networkFee + fixed protocol %,
// canonical revenue vault, RP-ID/UV parity with EVM, TTL caps, plus the adversarial
// list (squat, replay, substitution, rotation, close, tokens, rounding).
//
// Usage:
//   export PATH="$HOME/.local/share/solana/install/releases/2.3.13/solana-release/bin:$PATH"
//   cd contracts/svm/smart-account
//   PID_BACKEND=5as9TQo7Ua5iEBCKRbPhFUiRQX5dRJpjEQ9V91WddzaZ \
//   PID_TREASURY=J8HubZoRgyr4z29Rv97zXdEzWqMJQz69LFvWa82m25s9 cargo build-sbf
//   solana-test-validator --reset > /tmp/validator.log 2>&1 &
//   solana program deploy target/deploy/peridot_smart_account.so \
//     --program-id target/deploy/peridot_smart_account-keypair.json
//   node tests/integration.mjs <program-id>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, TransactionInstruction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

const PROGRAM = new PublicKey(process.argv[2] || "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT");
const SECP = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const DOMAIN_V3 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v3");
const DOMAIN_V2 = Buffer.from("PID|SOLANA|SMART_ACCOUNT|v2");
const RP_ID_HASH = crypto.createHash("sha256").update("peridot-id.example").digest();
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

const OP = { initialize: 0, withdrawSol: 1, withdrawToken: 2, updateAuthority: 3, close: 4, activate: 5, execute: 6 };
const POLICY_V1 = 1;
// Canonical V3 split (mirrors fee::split_attested_fee): relayerFee = networkFee,
// protocolFee = floor(networkFee * 5000 / 10000).
const protocolFeeOf = (net) => (BigInt(net) * 5000n) / 10_000n;

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const pidToSeed32 = (pid) => sha256(Buffer.from(pid.trim().toLowerCase(), "utf8"));

// Test-only backend + canonical revenue-vault keypairs.
// The program under test MUST be built with:
//   PID_BACKEND=5as9TQo7Ua5iEBCKRbPhFUiRQX5dRJpjEQ9V91WddzaZ (below secret)
//   PID_TREASURY=J8HubZoRgyr4z29Rv97zXdEzWqMJQz69LFvWa82m25s9 (below secret)
// Creation paths require BACKEND as payer/relayer; protocol fees go to TREASURY.
const BACKEND_SECRET = [2,165,58,5,85,113,187,187,189,165,0,247,194,28,78,38,100,30,150,157,210,65,241,136,120,108,19,175,51,247,44,88,68,27,157,74,181,156,0,3,4,104,44,101,23,145,208,210,131,227,116,208,145,70,66,152,114,42,243,151,173,78,79,158];
const TREASURY_SECRET = [208,255,148,158,50,192,250,184,231,51,204,195,166,2,29,129,110,106,56,172,8,112,127,77,140,144,60,245,75,170,89,14,254,116,220,42,95,208,228,150,212,52,66,86,186,148,243,197,174,81,12,59,43,26,161,41,217,156,62,166,30,185,3,180];
const backend = Keypair.fromSecretKey(Buffer.from(BACKEND_SECRET));
const treasuryKp = Keypair.fromSecretKey(Buffer.from(TREASURY_SECRET));

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

// V3 authenticatorData: rpIdHash ‖ UV flag ‖ counter. The program enforces the
// RP-ID hash and the UV bit exactly like the EVM counterpart.
function authData(rpId = RP_ID_HASH, flags = 0x05) {
  return Buffer.concat([rpId, Buffer.from([flags]), Buffer.from([0, 0, 0, 1])]);
}

function makeAssertion(payloadHash, { rpId, flags } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: b64url(payloadHash), origin: "https://peridot-id.example",
  }));
  const ad = authData(rpId, flags);
  return { clientDataJSON, messageData: Buffer.concat([ad, sha256(clientDataJSON)]) };
}

// Sign an arbitrary V3 payload hash with a P-256 keypair ({ privateKey, publicKey }).
function signPayload(keypair, payloadHash, assertionOpts) {
  const a = makeAssertion(payloadHash, assertionOpts);
  const sig = lowS(crypto.sign("sha256", a.messageData, { key: keypair.privateKey, dsaEncoding: "ieee-p1363" }));
  return { ...a, sig, comp: compressedPub(keypair.publicKey) };
}

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };

// ---- V3 payload builders (mirror contracts/V2_AUTHORIZATION.md §§2, 4) ----
const initPayloadV3 = (accountId32, authorityComp, rpId) =>
  sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.initialize]), accountId32, authorityComp, rpId]));
const activatePayloadV3 = (accountId32, authorityComp, rpId, policy, expiry) =>
  sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.activate]), accountId32, authorityComp, rpId, u16(policy), i64(expiry)]));
const withdrawPayloadV3 = (accountId32, nonce, amount, destBytes, expiry, policy, sourceBytes = null) => {
  const op = sourceBytes ? OP.withdrawToken : OP.withdrawSol;
  const parts = [DOMAIN_V3, Buffer.from([op]), accountId32, u64(nonce), u64(amount), destBytes, i64(expiry), u16(policy)];
  if (sourceBytes) parts.push(sourceBytes);
  return sha256(Buffer.concat(parts));
};
const rotatePayloadV3 = (accountId32, nonce, newAuth, expiry) =>
  sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.updateAuthority]), accountId32, u64(nonce), newAuth, i64(expiry)]));
const closePayloadV3 = (accountId32, nonce, destBytes, expiry) =>
  sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.close]), accountId32, u64(nonce), destBytes, i64(expiry)]));
// disc=6 execute V3: op-tag ‖ account ‖ nonce ‖ expiry ‖ policy ‖ call_hash,
// where call_hash = sha256(target ‖ count ‖ metas(addr ‖ flags) ‖ data_len ‖ data).
const FLAG_W = 1, FLAG_S = 2;
function execCall(target, metas, data) {
  return Buffer.concat([
    target, Buffer.from([metas.length]),
    ...metas.flatMap(([a, f]) => [a, Buffer.from([f])]),
    u16(data.length), data,
  ]);
}
const executePayloadV3 = (accountId32, nonce, expiry, policy, callHash) =>
  sha256(Buffer.concat([DOMAIN_V3, Buffer.from([OP.execute]), accountId32, u64(nonce), i64(expiry), u16(policy), callHash]));
// disc=6 layout: nonce|target|count|metas|data_len|data|expiry|policy|network_fee|len|json.
// Remaining keys cover each non-PDA meta in order (the PDA maps to account 0).
function executeIx(pda, relayerPub, nonce, target, metas, data, policy, networkFee, expiry, keypair, accountId32, assertionOpts) {
  const call = execCall(target, metas, data);
  const s = signPayload(keypair, executePayloadV3(accountId32, nonce, expiry, policy, sha256(call)), assertionOpts);
  const metaBytes = Buffer.concat(metas.flatMap(([a, f]) => [a, Buffer.from([f])]));
  const programIx = new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: relayerPub, isSigner: true, isWritable: true },
      { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(target), isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ...metas.filter(([a]) => !a.equals(pda.toBuffer())).map(([a, f]) => ({
        pubkey: new PublicKey(a), isSigner: false, isWritable: (f & FLAG_W) !== 0,
      })),
    ],
    programId: PROGRAM,
    data: wdData(6, [u64(nonce), target, Buffer.from([metas.length]), metaBytes, u16(data.length), data, i64(expiry), u16(policy), u64(networkFee)], s.clientDataJSON),
  });
  return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
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

// disc=1 withdraw_sol V3: nonce|amount|dest|expiry|policy|network_fee|len|json
function withdrawIx(pda, destPub, relayerPub, nonce, amount, destBytes, policy, networkFee, expiry, keypair, accountId32, assertionOpts) {
  const s = signPayload(keypair, withdrawPayloadV3(accountId32, nonce, amount, destBytes, expiry, policy), assertionOpts);
  const programIx = new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: destPub, isSigner: false, isWritable: true },
      { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: relayerPub, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: wdData(1, [u64(nonce), u64(amount), destBytes, i64(expiry), u16(policy), u64(networkFee)], s.clientDataJSON),
  });
  return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
}

// disc=3 update_authority V3: nonce|new_authority|expiry|len|json
function updateAuthIx(pda, accountId32, nonce, newAuth, expiry, keypair, assertionOpts) {
  const s = signPayload(keypair, rotatePayloadV3(accountId32, nonce, newAuth, expiry), assertionOpts);
  const programIx = new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: wdData(3, [u64(nonce), newAuth, i64(expiry)], s.clientDataJSON),
  });
  return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
}

// disc=0 initialize V3: account_id|authority|rp_id|len|json
function initTx(accountId32, authorityComp, rpId, payerPub, pda, keypair, assertionOpts) {
  const s = signPayload(keypair, initPayloadV3(accountId32, authorityComp, rpId), assertionOpts);
  const programIx = new TransactionInstruction({
    keys: [
      { pubkey: payerPub, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([0]), accountId32, authorityComp, rpId, u16(s.clientDataJSON.length), s.clientDataJSON]),
  });
  return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
}

// disc=5 activate V3: account_id|authority|rp_id|policy|expiry|network_fee|len|json
function activateIx(accountId32, authorityComp, rpId, policy, expiry, networkFee, relayerPub, pda, keypair, assertionOpts) {
  const s = signPayload(keypair, activatePayloadV3(accountId32, authorityComp, rpId, policy, expiry), assertionOpts);
  const programIx = new TransactionInstruction({
    keys: [
      { pubkey: relayerPub, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: Buffer.concat([Buffer.from([5]), accountId32, authorityComp, rpId, u16(policy), i64(expiry), u64(networkFee), u16(s.clientDataJSON.length), s.clientDataJSON]),
  });
  return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
}

// disc=4 close V3: nonce|expiry|len|json
function closeIx(pda, accountId32, destPub, nonce, expiry, keypair, assertionOpts) {
  const s = signPayload(keypair, closePayloadV3(accountId32, nonce, destPub.toBuffer(), expiry), assertionOpts);
  const programIx = new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: destPub, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: wdData(4, [u64(nonce), i64(expiry)], s.clientDataJSON),
  });
  return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
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
    console.error(`LOGS ${label}:`, logs ? logs.join(" | ") : "(no logs)");
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

async function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const authorityComp = compressedPub(publicKey);
  const { privateKey: k2, publicKey: p2 } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

  const rentPayer = Keypair.generate();
  const dest = Keypair.generate();
  const NETWORK_FEE = 100_000n;
  const PROTOCOL_FEE = protocolFeeOf(NETWORK_FEE); // 50000
  const TOTAL_FEE = NETWORK_FEE + PROTOCOL_FEE; // 150000
  await conn.confirmTransaction(await conn.requestAirdrop(rentPayer.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
  await conn.confirmTransaction(await conn.requestAirdrop(dest.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  await conn.confirmTransaction(await conn.requestAirdrop(treasuryKp.publicKey, LAMPORTS_PER_SOL), "confirmed");
  await conn.confirmTransaction(await conn.requestAirdrop(backend.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");

  const chainNow = await conn.getBlockTime(await conn.getSlot());
  const exp = (delta = 300) => chainNow + delta;
  // Fresh chain clock (the snapshot above drifts as the suite runs — TTL-boundary
  // cases must measure against live time or they genuinely execute and burn nonces).
  const liveNow = async () => conn.getBlockTime(await conn.getSlot());
  const accountId32 = pidToSeed32("testmain@pid");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("peridot_id"), Buffer.from("account"), accountId32], PROGRAM);
  console.log(`program ${PROGRAM.toBase58()} pda ${pda.toBase58()}`);

  // ---- initialize: stranger payer rejected even with a valid self-signature ----
  await expectErr(
    initTx(accountId32, authorityComp, RP_ID_HASH, rentPayer.publicKey, pda, { privateKey, publicKey }),
    [rentPayer],
    "stranger-funded initialize rejected (Forbidden)",
  );

  // ---- initialize: squat attempt (stranger claims victim id with own key) ----
  const squatId = pidToSeed32("testsquat@pid");
  const [squatPda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), squatId], PROGRAM);
  const squatAuth = compressedPub(p2);
  await expectErr(
    initTx(squatId, squatAuth, RP_ID_HASH, rentPayer.publicKey, squatPda, { privateKey: k2, publicKey: p2 }),
    [rentPayer],
    "squat rejected (Forbidden)",
  );
  assert.equal(await conn.getAccountInfo(squatPda), null, "squat created nothing");

  // ---- initialize (backend-paid, passkey-signed, V2 state) ----
  await expectOk(
    initTx(accountId32, authorityComp, RP_ID_HASH, backend.publicKey, pda, { privateKey, publicKey }),
    [backend],
    "initialize",
  );

  const acct = await conn.getAccountInfo(pda);
  assert.equal(acct.data.length, 112, "state len 112 (v2)");
  assert.equal(acct.data[0], 2, "version = 2");
  assert.equal(acct.data[1], 1, "authority_type = secp256r1");
  assert.equal(acct.data.readBigUInt64LE(4), 0n, "nonce = 0");
  assert.equal(Buffer.from(acct.data.subarray(12, 45)).equals(authorityComp), true, "authority stored");
  assert.equal(Buffer.from(acct.data.subarray(48, 80)).equals(accountId32), true, "account_id stored");
  assert.equal(Buffer.from(acct.data.subarray(80, 112)).equals(RP_ID_HASH), true, "rp_id_hash stored");
  results.push("PASS v2 state layout");

  // ---- initialize again → AlreadyInitialized ----
  await expectErr(
    initTx(accountId32, authorityComp, RP_ID_HASH, backend.publicKey, pda, { privateKey, publicKey }),
    [backend],
    "re-initialize rejected",
  );

  // ---- RP-ID mismatch at creation is impossible (payload binds it); wrong-RP assertion fails ----
  await expectErr(
    initTx(squatId, squatAuth, RP_ID_HASH, backend.publicKey, squatPda, { privateKey: k2, publicKey: p2 },
      { rpId: sha256("evil.example") }),
    [backend],
    "wrong-RP assertion rejected (Unauthorized)",
  );

  // ---- activate: Peridot-sponsored claim + attested split (disc 5) ----
  {
    const actId = pidToSeed32("testactivate@pid");
    const [actPda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), actId], PROGRAM);
    const funded = 150_000_000; // 0.15 SOL
    await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: rentPayer.publicKey, toPubkey: actPda, lamports: funded })
    ), [rentPayer], { commitment: "confirmed" }), "confirmed");

    const beforeBackend = (await conn.getAccountInfo(backend.publicKey)).lamports;
    const beforeTreasury = (await conn.getAccountInfo(treasuryKp.publicKey)).lamports;
    const actExpiry = exp();
    await expectErr(
      activateIx(actId, authorityComp, RP_ID_HASH, POLICY_V1, actExpiry, NETWORK_FEE, rentPayer.publicKey, actPda, { privateKey, publicKey }),
      [rentPayer],
      "stranger-relayed activate rejected (Forbidden)",
    );
    await expectOk(
      activateIx(actId, authorityComp, RP_ID_HASH, POLICY_V1, actExpiry, NETWORK_FEE, backend.publicKey, actPda, { privateKey, publicKey }),
      [backend],
      "activate claims PDA and splits relayer/protocol",
    );

    const claimed = await conn.getAccountInfo(actPda);
    assert.ok(claimed, "activate created on-chain account");
    assert.equal(claimed.data.length, 112, "activate wrote 112-byte v2 state");
    assert.equal(claimed.owner.toBase58(), PROGRAM.toBase58(), "activate transferred ownership to program");
    assert.equal(claimed.lamports, funded - Number(TOTAL_FEE), "total fee reimbursed out of PDA");
    // Backend paid the tx fee (~5000) on top, so assert protocol exactly, relayer at-least.
    const afterTreasury = (await conn.getAccountInfo(treasuryKp.publicKey)).lamports;
    assert.equal(afterTreasury - beforeTreasury, Number(PROTOCOL_FEE), "vault received exactly the protocol fee");
    const afterBackend = (await conn.getAccountInfo(backend.publicKey)).lamports;
    assert.ok(afterBackend - beforeBackend >= Number(NETWORK_FEE) - 50_000, "backend received network reimbursement");
    results.push("PASS activate state + fee split");
  }

  // ---- activate an already-initialized account → rejected ----
  await expectErr(
    activateIx(accountId32, authorityComp, RP_ID_HASH, POLICY_V1, exp(), NETWORK_FEE, backend.publicKey, pda, { privateKey, publicKey }),
    [backend],
    "activate on initialized account rejected",
  );

  // ---- activate with non-canonical vault account → InvalidDestination ----
  {
    const swapId = pidToSeed32("testswaptreasury@pid");
    const [swapPda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), swapId], PROGRAM);
    await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: rentPayer.publicKey, toPubkey: swapPda, lamports: 150_000_000 })
    ), [rentPayer], { commitment: "confirmed" }), "confirmed");
    // V3 has no per-call treasury: tamper the account list instead.
    const s = signPayload({ privateKey, publicKey },
      activatePayloadV3(swapId, authorityComp, RP_ID_HASH, POLICY_V1, exp()));
    const evilTreasury = Keypair.generate();
    const swapIx = new TransactionInstruction({
      keys: [
        { pubkey: backend.publicKey, isSigner: true, isWritable: true },
        { pubkey: swapPda, isSigner: false, isWritable: true },
        { pubkey: evilTreasury.publicKey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: Buffer.concat([Buffer.from([5]), swapId, authorityComp, RP_ID_HASH, u16(POLICY_V1), i64(exp()), u64(NETWORK_FEE), u16(s.clientDataJSON.length), s.clientDataJSON]),
    });
    await expectErr(
      new Transaction().add(swapIx, buildSecpIx(s.comp, s.sig, s.messageData)),
      [backend],
      "non-canonical vault rejected (InvalidDestination)",
    );
    assert.equal((await conn.getAccountInfo(swapPda)).owner.toBase58(), SystemProgram.programId.toBase58(), "swapped activate claimed nothing");
  }

  // ---- activate with unknown policy → UnknownFeePolicy ----
  {
    const polId = pidToSeed32("testpolicy@pid");
    const [polPda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), polId], PROGRAM);
    await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: rentPayer.publicKey, toPubkey: polPda, lamports: 150_000_000 })
    ), [rentPayer], { commitment: "confirmed" }), "confirmed");
    await expectErr(
      activateIx(polId, authorityComp, RP_ID_HASH, 2, exp(), NETWORK_FEE, backend.publicKey, polPda, { privateKey, publicKey }),
      [backend],
      "unknown policy rejected (UnknownFeePolicy)",
    );
  }

  // ---- deposit (plain transfer) ----
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: rentPayer.publicKey, toPubkey: pda, lamports: 10_000_000 })
  ), [rentPayer], { commitment: "confirmed" });

  // ---- withdraw: valid (relayer-sponsored, attested split) ----
  const destBytes = dest.publicKey.toBuffer();
  const expiry = exp();
  const treasury0 = (await conn.getAccountInfo(treasuryKp.publicKey)).lamports;
  const dest0 = (await conn.getAccountInfo(dest.publicKey)).lamports;
  // Save the valid nonce-0 assertion for the cross-account replay case below.
  const replayAssertion = signPayload({ privateKey, publicKey },
    withdrawPayloadV3(accountId32, 0, 5_000_000, destBytes, expiry, POLICY_V1));
  const replaySig = replayAssertion.sig;
  const replayComp = replayAssertion.comp;
  const replayClientData = replayAssertion.clientDataJSON;
  const replayMessage = replayAssertion.messageData;
  await expectOk(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 0, 5_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey, publicKey }, accountId32),
    [rentPayer],
    "withdraw valid",
  );
  assert.equal((await conn.getAccountInfo(dest.publicKey)).lamports - dest0, 5_000_000, "dest received amount");
  assert.equal((await conn.getAccountInfo(treasuryKp.publicKey)).lamports - treasury0, Number(PROTOCOL_FEE), "protocol fee to canonical vault");
  results.push("PASS attested fee split");

  // ---- unauthorized transfer (wrong passkey) ----
  await expectErr(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey: k2, publicKey: p2 }, accountId32),
    [rentPayer],
    "unauthorized passkey rejected",
  );

  // ---- invalid nonce / replay ----
  await expectErr(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 0, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey, publicKey }, accountId32),
    [rentPayer],
    "replay (nonce 0) rejected",
  );
  await expectErr(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 99, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey, publicKey }, accountId32),
    [rentPayer],
    "invalid nonce rejected",
  );

  // ---- expired expiry + over-TTL expiry ----
  await expectErr(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, chainNow - 60, { privateKey, publicKey }, accountId32),
    [rentPayer],
    "expired expiry rejected",
  );
  await expectErr(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, (await liveNow()) + 660, { privateKey, publicKey }, accountId32),
    [rentPayer],
    "over-TTL expiry rejected",
  );

  // ---- transaction substitution (challenge binds amount X, executes Y) ----
  await expectErr((() => {
    const s = signPayload({ privateKey, publicKey },
      withdrawPayloadV3(accountId32, 1, 1_000_000, destBytes, expiry, POLICY_V1));
    const programIx = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: dest.publicKey, isSigner: false, isWritable: true },
        { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: rentPayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: wdData(1, [u64(1), u64(9_000_000), destBytes, i64(expiry), u16(POLICY_V1), u64(NETWORK_FEE)], s.clientDataJSON),
    });
    return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
  })(), [rentPayer], "challenge/args mismatch rejected");

  // ---- V2-shaped payload must not verify as V3 ----
  await expectErr((() => {
    const v2 = sha256(Buffer.concat([Buffer.from("PID|SOLANA|SMART_ACCOUNT|v2"),
      Buffer.from([OP.withdrawSol]), accountId32, u64(1), u64(1_000_000), destBytes, i64(expiry), u64(NETWORK_FEE), u16(POLICY_V1)]));
    const s = signPayload({ privateKey, publicKey }, v2);
    const programIx = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: dest.publicKey, isSigner: false, isWritable: true },
        { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: rentPayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: wdData(1, [u64(1), u64(1_000_000), destBytes, i64(expiry), u16(POLICY_V1), u64(NETWORK_FEE)], s.clientDataJSON),
    });
    return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
  })(), [rentPayer], "V2 payload rejected as V3");

  // ---- cross-account replay: A's nonce-0 assertion replayed on sibling B ----
  {
    const sibId = pidToSeed32("testsibling@pid");
    const [sibPda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), sibId], PROGRAM);
    await expectOk(
      initTx(sibId, authorityComp, RP_ID_HASH, backend.publicKey, sibPda, { privateKey, publicKey }),
      [backend],
      "sibling initialized under shared authority",
    );
    await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(
      SystemProgram.transfer({ fromPubkey: rentPayer.publicKey, toPubkey: sibPda, lamports: 10_000_000 })
    ), [rentPayer], { commitment: "confirmed" }), "confirmed");
    // Same authority, same nonce (0), same everything — but the payload binds A's account_id.
    const replayIx = new TransactionInstruction({
      keys: [
        { pubkey: sibPda, isSigner: false, isWritable: true },
        { pubkey: dest.publicKey, isSigner: false, isWritable: true },
        { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: rentPayer.publicKey, isSigner: true, isWritable: true },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: wdData(1, [u64(0), u64(5_000_000), destBytes, i64(expiry), u16(POLICY_V1), u64(NETWORK_FEE)], replayClientData),
    });
    const sibBefore = (await conn.getAccountInfo(sibPda)).lamports;
    await expectErr(
      new Transaction().add(replayIx, buildSecpIx(replayComp, replaySig, replayMessage)),
      [rentPayer],
      "cross-account replay rejected (InvalidChallenge)",
    );
    assert.equal((await conn.getAccountInfo(sibPda)).lamports, sibBefore, "sibling untouched by replay");
  }

  // ---- wrong-RP and missing-UV assertions rejected ----
  await expectErr(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey, publicKey }, accountId32, { rpId: sha256("evil.example") }),
    [rentPayer],
    "wrong-RP assertion rejected (Unauthorized)",
  );
  await expectErr(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey, publicKey }, accountId32, { flags: 0x01 }),
    [rentPayer],
    "missing-UV assertion rejected (Unauthorized)",
  );

  // ---- account mismatch (wrong PDA in args vs actual) ----
  const otherId = pidToSeed32("testother@pid");
  const [otherPda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), otherId], PROGRAM);
  await expectErr(
    withdrawIx(otherPda, dest.publicKey, rentPayer.publicKey, 1, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey, publicKey }, accountId32),
    [rentPayer],
    "account (PDA) mismatch rejected",
  );

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
  await expectOk(updateAuthIx(pda, accountId32, 1, newAuth, expiry, { privateKey, publicKey }), [rentPayer], "update_authority valid");

  // Zero-key rotation must be rejected even with a valid signature shape.
  await expectErr((() => {
    const s = signPayload({ privateKey: k2, publicKey: p2 },
      rotatePayloadV3(accountId32, 2, Buffer.alloc(33), expiry));
    const programIx = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: wdData(3, [u64(2), Buffer.alloc(33), i64(expiry)], s.clientDataJSON),
    });
    return new Transaction().add(programIx, buildSecpIx(s.comp, s.sig, s.messageData));
  })(), [rentPayer], "zero-key rotation rejected");

  // Now the OLD key must be rejected, the NEW key accepted.
  await expectErr(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 2, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey, publicKey }, accountId32),
    [rentPayer],
    "old authority rejected after rotation",
  );
  await expectOk(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 2, 1_000_000, destBytes, POLICY_V1, NETWORK_FEE, expiry, { privateKey: k2, publicKey: p2 }, accountId32),
    [rentPayer],
    "new authority accepted after rotation",
  );

  // ---- rounding boundary: 1-lamport network fee → protocol 0, relayer made whole ----
  await expectOk(
    withdrawIx(pda, dest.publicKey, rentPayer.publicKey, 3, 1_000, destBytes, POLICY_V1, 1, expiry, { privateKey: k2, publicKey: p2 }, accountId32),
    [rentPayer],
    "dust rounding withdraw valid",
  );

  // ---- close: valid on a throwaway account; self-destination rejected ----
  {
    const closeId = pidToSeed32("testclose@pid");
    const [closePda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), closeId], PROGRAM);
    await expectOk(
      initTx(closeId, authorityComp, RP_ID_HASH, backend.publicKey, closePda, { privateKey, publicKey }),
      [backend],
      "close-test account initialized",
    );
    await expectErr(
      closeIx(closePda, closeId, closePda, 0, exp(), { privateKey, publicKey }),
      [rentPayer],
      "close to self rejected (InvalidDestination)",
    );
    const destBefore = (await conn.getAccountInfo(dest.publicKey)).lamports;
    const pdaBefore = (await conn.getAccountInfo(closePda)).lamports;
    await expectOk(
      closeIx(closePda, closeId, dest.publicKey, 0, exp(), { privateKey, publicKey }),
      [rentPayer],
      "close valid (rent drained)",
    );
    assert.equal((await conn.getAccountInfo(dest.publicKey)).lamports - destBefore, pdaBefore, "rent returned to destination");
    assert.equal(await conn.getAccountInfo(closePda), null, "closed account removed");
  }

  // ---- sponsored token withdraw (disc 2) — tokens move via SPL CPI, attested split ----
  {
    const TOKEN_PROG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const mintAuth = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(mintAuth.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const mint = await createMint(conn, mintAuth, mintAuth.publicKey, null, 6);
    const smartToken = await getOrCreateAssociatedTokenAccount(conn, mintAuth, mint, pda, true);
    const destToken = await getOrCreateAssociatedTokenAccount(conn, mintAuth, mint, dest.publicKey);
    await mintTo(conn, mintAuth, mint, smartToken.address, mintAuth, 10_000_000);
    results.push("PASS token ATA + mint");
    // nonce is 4 (withdraw 0, rotate 1, withdraw 2, dust withdraw 3; close used a throwaway).
    const ttNet = 100_000n;
    const ttAmount = 2_000_000n;
    const tokenAtaBytes = destToken.address.toBuffer();
    const ttExpiry = exp();
    const ttPayload = withdrawPayloadV3(accountId32, 4, ttAmount, tokenAtaBytes, ttExpiry, POLICY_V1, smartToken.address.toBuffer());
    const ttAssertion = makeAssertion(ttPayload);
    const ttSig = lowS(crypto.sign("sha256", ttAssertion.messageData, { key: k2, dsaEncoding: "ieee-p1363" }));
    const ttComp = compressedPub(p2);
    const tokenIx = new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: smartToken.address, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destToken.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROG, isSigner: false, isWritable: false },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
        { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: true },
        { pubkey: rentPayer.publicKey, isSigner: true, isWritable: true },
      ],
      programId: PROGRAM,
      data: wdData(2, [u64(4), u64(ttAmount), tokenAtaBytes, i64(ttExpiry), u16(POLICY_V1), u64(ttNet)], ttAssertion.clientDataJSON),
    });
    const treasuryBefore = (await conn.getAccountInfo(treasuryKp.publicKey)).lamports;
    await expectOk(new Transaction().add(tokenIx, buildSecpIx(ttComp, ttSig, ttAssertion.messageData)), [rentPayer], "sponsored withdraw token valid");
    const smartBal = (await conn.getTokenAccountBalance(smartToken.address)).value.uiAmount;
    const destBal = (await conn.getTokenAccountBalance(destToken.address)).value.uiAmount;
    assert.equal(smartBal, 8, "smart ATA debited by token amount");
    assert.equal(destBal, 2, "dest ATA credited");
    const treasuryAfter = (await conn.getAccountInfo(treasuryKp.publicKey)).lamports;
    assert.equal(treasuryAfter - treasuryBefore, Number(protocolFeeOf(ttNet)), "token withdraw protocol fee exact");
    results.push("PASS token withdraw state + protocol fee");
  }

  // ---- generic execute (disc 6) — SPL transfer via CPI with the PDA as authority ----
  // Nonce is 5 (withdraw 0, rotate 1, withdraw 2, dust 3, token 4); authority is k2.
  {
    const TOKEN_PROG = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    const mintAuth = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(mintAuth.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const mint = await createMint(conn, mintAuth, mintAuth.publicKey, null, 6);
    const smartToken = await getOrCreateAssociatedTokenAccount(conn, mintAuth, mint, pda, true);
    const destToken = await getOrCreateAssociatedTokenAccount(conn, mintAuth, mint, dest.publicKey);
    await mintTo(conn, mintAuth, mint, smartToken.address, mintAuth, 5_000_000);
    const exAmount = 1_000_000n;
    // Token Transfer: accounts [source, destination, authority=PDA], data [3 ‖ amount].
    const exData = Buffer.concat([Buffer.from([3]), u64(exAmount)]);
    const exMetas = [
      [smartToken.address.toBuffer(), FLAG_W],
      [destToken.address.toBuffer(), FLAG_W],
      [pda.toBuffer(), FLAG_S],
    ];
    const exExpiry = exp();
    // Shape-faithful fee estimate (same 2-ix layout, same signer count).
    const exProbe = executeIx(pda, rentPayer.publicKey, 5, TOKEN_PROG.toBuffer(), exMetas, exData, POLICY_V1, 0n, exExpiry, { privateKey: k2, publicKey: p2 }, accountId32);
    exProbe.feePayer = rentPayer.publicKey;
    exProbe.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const exEst = BigInt((await conn.getFeeForMessage(exProbe.compileMessage(), "confirmed")).value ?? 0);
    assert.ok(exEst > 0n, "estimate is nonzero");
    // Attest the estimate exactly (proves quotes land); nonce 5.
    const exTreasuryBefore = (await conn.getAccountInfo(treasuryKp.publicKey)).lamports;
    const exTx = executeIx(pda, rentPayer.publicKey, 5, TOKEN_PROG.toBuffer(), exMetas, exData, POLICY_V1, exEst, exExpiry, { privateKey: k2, publicKey: p2 }, accountId32);
    let exSig = null;
    try {
      exSig = await sendAndConfirmTransaction(conn, exTx, [rentPayer], { commitment: "confirmed", skipPreflight: true });
      results.push("PASS execute SPL transfer via generic CPI"); passed++;
    } catch (e) {
      const logs = await e.getLogs?.().catch(() => null);
      console.error("LOGS execute:", logs ? logs.join(" | ") : "(no logs)");
      results.push(`FAIL execute SPL transfer via generic CPI: ${String(e.message).split("\n")[0]}`); failed++;
    }
    if (exSig) {
      const smartBal = (await conn.getTokenAccountBalance(smartToken.address)).value.amount;
      const destBal = (await conn.getTokenAccountBalance(destToken.address)).value.amount;
      assert.equal(smartBal, "4000000", "execute debited the PDA-owned source");
      assert.equal(destBal, "1000000", "execute credited the destination");
      const exTreasuryAfter = (await conn.getAccountInfo(treasuryKp.publicKey)).lamports;
      assert.equal(exTreasuryAfter - exTreasuryBefore, Number(protocolFeeOf(exEst)), "execute protocol fee exact");
      results.push("PASS execute token balances + protocol fee");
      // Fee accuracy: quoted estimate vs landed meta.fee must agree within 10%.
      const landed = await conn.getTransaction(exSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const actual = BigInt(landed.meta.fee);
      const driftPct = exEst >= actual
        ? Number(((exEst - actual) * 100n) / actual)
        : Number(((actual - exEst) * 100n) / actual);
      assert.ok(driftPct <= 10, `fee accuracy within 10% (est=${exEst} actual=${actual})`);
      results.push(`PASS execute fee accuracy (est=${exEst} actual=${actual})`);
    }
    // Self-call denies even with a correctly signed payload (nonce 6 never burns).
    const selfMetas = [[pda.toBuffer(), FLAG_S]];
    await expectErr(
      executeIx(pda, rentPayer.publicKey, 6, PROGRAM.toBuffer(), selfMetas, Buffer.alloc(0), POLICY_V1, 100_000n, exp(), { privateKey: k2, publicKey: p2 }, accountId32),
      [rentPayer],
      "execute self-target rejected (InvalidTarget)",
    );
    // No PDA delegation denies (correctly signed, but the call cannot act as the user).
    await expectErr(
      executeIx(pda, rentPayer.publicKey, 6, TOKEN_PROG.toBuffer(), [[smartToken.address.toBuffer(), FLAG_W]], exData, POLICY_V1, 100_000n, exp(), { privateKey: k2, publicKey: p2 }, accountId32),
      [rentPayer],
      "execute without PDA delegation rejected (Unauthorized)",
    );
    // Call substitution denies: sign amount A, submit amount B.
    {
      const otherData = Buffer.concat([Buffer.from([3]), u64(2_000_000n)]);
      const call = execCall(TOKEN_PROG.toBuffer(), exMetas, exData);
      const s = signPayload({ privateKey: k2, publicKey: p2 }, executePayloadV3(accountId32, 6, exExpiry, POLICY_V1, sha256(call)));
      const metaBytes = Buffer.concat(exMetas.flatMap(([a, f]) => [a, Buffer.from([f])]));
      const subIx = new TransactionInstruction({
        keys: [
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: rentPayer.publicKey, isSigner: true, isWritable: true },
          { pubkey: treasuryKp.publicKey, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROG, isSigner: false, isWritable: false },
          { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
          { pubkey: smartToken.address, isSigner: false, isWritable: true },
          { pubkey: destToken.address, isSigner: false, isWritable: true },
        ],
        programId: PROGRAM,
        data: wdData(6, [u64(6), TOKEN_PROG.toBuffer(), Buffer.from([exMetas.length]), metaBytes, u16(otherData.length), otherData, i64(exExpiry), u16(POLICY_V1), u64(100_000n)], s.clientDataJSON),
      });
      await expectErr(new Transaction().add(subIx, buildSecpIx(s.comp, s.sig, s.messageData)), [rentPayer], "execute call substitution rejected (InvalidChallenge)");
    }
  }

  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("INTEGRATION OK");
}
main().catch((e) => { console.log(results.join("\n")); console.error("FAIL", e); process.exit(1); });
