// PeridotID session layer — adversarial integration suite (ADR-010).
//
// Runs against a local `solana-test-validator` with the smart-account program
// AND the mock-forwarder program deployed. Proves the PDA-signer-isolation
// boundary: the vault PDA never enters game CPIs; the session PDA (rent-only)
// is the sole lent signer; protected accounts are hash-pinned pre/post CPI.
//
// Two runtime facts this suite pins (verified against chain truth, not assumed):
// - System transfers debit only data-less accounts ("from must not carry
//   data"), so session SOL is structurally immobile — even forwarded.
// - A forwarded Ed25519-style signer bit DOES authorize token transfers, so
//   session-owned tokens are the honest forwarding residual (vault: never).
//
// Usage:
//   export PATH="$HOME/.local/share/solana/install/releases/2.3.13/solana-release/bin:$PATH"
//   cd contracts/svm/smart-account
//   PID_BACKEND=<key> PID_TREASURY=<key> cargo build-sbf
//   solana-test-validator --reset > /tmp/validator.log 2>&1 &
//   solana program deploy target/deploy/peridot_smart_account.so \
//     --program-id target/deploy/peridot_smart_account-keypair.json
//   solana-keygen new -o /tmp/forwarder-keypair.json --no-bip39-passphrase
//   solana program deploy ../../mock-forwarder/target/deploy/peridot_mock_forwarder.so \
//     --program-id /tmp/forwarder-keypair.json
//   node tests/session.mjs <program-id> <forwarder-id>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, TransactionInstruction,
} from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";

const PROGRAM = new PublicKey(process.argv[2] || "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT");
if (!process.argv[3]) throw new Error("pass forwarder program id as argv[3]");
const FORWARDER = new PublicKey(process.argv[3]);
const SECP = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
const INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const DOMAIN_SESSION = Buffer.from("PID|SOLANA|SESSION|v1");
const RP_ID_HASH = crypto.createHash("sha256").update("peridot-id.example").digest();
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const SESSION_DISC = { register: 7, execute: 8, revoke: 9, close: 10 };
const SESSION_STATE_LEN = 205;

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
const b64url = (b) => Buffer.from(b).toString("base64url");
const pidToSeed32 = (pid) => sha256(Buffer.from(pid.trim().toLowerCase(), "utf8"));
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

const BACKEND_SECRET = [2,165,58,5,85,113,187,187,189,165,0,247,194,28,78,38,100,30,150,157,210,65,241,136,120,108,19,175,51,247,44,88,68,27,157,74,181,156,0,3,4,104,44,101,23,145,208,210,131,227,116,208,145,70,66,152,114,42,243,151,173,78,79,158];
const backend = Keypair.fromSecretKey(Buffer.from(BACKEND_SECRET));

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
function signPayload(keypair, payloadHash, assertionOpts) {
  const a = makeAssertion(payloadHash, assertionOpts);
  const sig = lowS(crypto.sign("sha256", a.messageData, { key: keypair.privateKey, dsaEncoding: "ieee-p1363" }));
  return { ...a, sig, comp: compressedPub(keypair.publicKey) };
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

// ---- session payload builders (mirror auth.rs DOMAIN_SESSION + op tags) ----
const registerPayload = (accountId32, nonce, sessionKey, program, expiresAt, hasAuth, auth, slot, expiry) =>
  sha256(Buffer.concat([DOMAIN_SESSION, Buffer.from([7]), accountId32, u64(nonce), sessionKey, program, i64(expiresAt), Buffer.from([hasAuth ? 1 : 0]), auth, u64(slot), i64(expiry)]));
const revokePayload = (accountId32, sessionKey, nonce, expiry) =>
  sha256(Buffer.concat([DOMAIN_SESSION, Buffer.from([9]), accountId32, sessionKey, u64(nonce), i64(expiry)]));
const closePayload = (accountId32, sessionKey, dest, nonce, expiry) =>
  sha256(Buffer.concat([DOMAIN_SESSION, Buffer.from([10]), accountId32, sessionKey, dest, u64(nonce), i64(expiry)]));

const sessionPdaOf = (accountId32, sessionKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("session"), accountId32, sessionKey.toBuffer()], PROGRAM)[0];
const programDataOf = (programId) =>
  PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER)[0];
// Upgrade evidence per loader class: verified ProgramData (upgradeable games)
// or the game program itself (immutable: native/deprecated loader, e.g. SPL Token).
const NATIVE_LOADER = "11111111111111111111111111111111";
const DEPRECATED_LOADER = "BPFLoader2111111111111111111111111111111111";
async function evidenceOf(game) {
  const info = await conn.getAccountInfo(game);
  assert.ok(info, "game program exists");
  const owner = info.owner.toBase58();
  if (owner === LOADER.toBase58()) return programDataOf(game);
  assert.ok(owner === NATIVE_LOADER || owner === DEPRECATED_LOADER, `known loader class, got ${owner}`);
  return game;
}
function parseProgramData(data) {
  assert.equal(data.readUInt32LE(0), 3, "ProgramData variant");
  const slot = data.readBigUInt64LE(4);
  const tag = data[12];
  assert.ok(tag === 0 || tag === 1, "authority tag");
  return { slot, hasAuth: tag === 1, auth: Buffer.from(data.subarray(13, 45)) };
}
// Forwarder call: forward (target, innerData) with explicit per-account flags.
function forwarderCall(target, innerData, accounts) {
  return Buffer.concat([
    target.toBuffer(), u16(innerData.length), innerData, Buffer.from([accounts.length]),
    ...accounts.flatMap(([a, signer, writable]) => [a.toBuffer(), Buffer.from([signer ? 1 : 0, writable ? 1 : 0])]),
  ]);
}
const systemTransferData = (lamports) => Buffer.concat([u32(2), u64(lamports)]);

let passed = 0;
let failed = 0;
const results = [];
async function expectOk(tx, signers, label) {
  try {
    await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: true });
    results.push(`PASS ${label}`); passed++;
  } catch (e) {
    const logs = await e.getLogs?.().catch(() => null);
    console.error(`LOGS ${label}:`, logs ? logs.join(" | ") : "(no logs)");
    console.error(`ERRMSG ${label}:`, String(e.message).split("\n").slice(0, 3).join(" / ").slice(0, 400));
    results.push(`FAIL ${label}: ${String(e.message).split("\n")[0]}`); failed++;
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
async function expectErrCode(tx, signers, codeHex, label) {
  try {
    await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: true });
    results.push(`FAIL ${label} (expected rejection, tx succeeded)`); failed++;
  } catch (e) {
    // NOTE: SendTransactionError.getLogs() is broken in this web3 pin — read
    // the failed transaction's logs directly instead.
    let code = null;
    const sig = e.signature;
    if (sig) {
      for (let i = 0; i < 15 && !code; i++) {
        const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
        const logs = t?.meta?.logMessages || [];
        const hit = logs.find((l) => l.includes("custom program error: "));
        if (hit) code = (hit.match(/0x[0-9a-f]+/) || [])[0] || null;
        else if (logs.length > 0) code = "nologic";
        if (!code) await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (code === codeHex) { results.push(`PASS ${label}`); passed++; }
    else {
      console.error(`LOGS ${label}: want=${codeHex} got=${code}`);
      results.push(`FAIL ${label} (wrong error, want ${codeHex} got ${code})`); failed++;
    }
  }
}

async function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const owner = { privateKey, publicKey };
  const authorityComp = compressedPub(publicKey);
  const payer = Keypair.generate();
  const sessionKp = Keypair.generate();
  const session3 = Keypair.generate();
  const userWallet = Keypair.generate();
  const attackerWallet = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
  await conn.confirmTransaction(await conn.requestAirdrop(backend.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");
  await conn.confirmTransaction(await conn.requestAirdrop(sessionKp.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  await conn.confirmTransaction(await conn.requestAirdrop(session3.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");

  const chainNow = await conn.getBlockTime(await conn.getSlot());
  const exp = (delta = 300) => chainNow + delta;
  const liveNow = async () => conn.getBlockTime(await conn.getSlot());
  const accountId32 = pidToSeed32(`testsession${Date.now()}@pid`);
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("peridot_id"), Buffer.from("account"), accountId32], PROGRAM);
  const sessionPda = sessionPdaOf(accountId32, sessionKp.publicKey);
  const sessionPda3 = sessionPdaOf(accountId32, session3.publicKey);
  console.log(`program ${PROGRAM.toBase58()} vault ${pda.toBase58()}`);

  // ---- vault setup (initialize + fund + SPL position) ----
  {
    const s = signPayload(owner, sha256(Buffer.concat([Buffer.from("PID|SOLANA|SMART_ACCOUNT|v3"), Buffer.from([0]), accountId32, authorityComp, RP_ID_HASH])));
    const tx = new Transaction().add(new TransactionInstruction({
      keys: [
        { pubkey: backend.publicKey, isSigner: true, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: Buffer.concat([Buffer.from([0]), accountId32, authorityComp, RP_ID_HASH, u16(s.clientDataJSON.length), s.clientDataJSON]),
    }), buildSecpIx(s.comp, s.sig, s.messageData));
    await expectOk(tx, [backend], "vault initialize");
  }
  await conn.confirmTransaction(await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pda, lamports: 2 * LAMPORTS_PER_SOL })
  ), [payer], { commitment: "confirmed" }), "confirmed");

  // SPL positions: vault-owned (defense target) + session-owned (working capital).
  const mintAuthority = Keypair.generate();
  const mint = await createMint(conn, payer, mintAuthority.publicKey, null, 6);
  const vaultAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, pda, true);
  await mintTo(conn, payer, mint, vaultAta.address, mintAuthority, 1_000_000n);
  const vaultAtaStart = (await conn.getTokenAccountBalance(vaultAta.address)).value.amount;
  const sessionAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, sessionPda, true);
  await mintTo(conn, payer, mint, sessionAta.address, mintAuthority, 500_000n);
  const sessionAta3 = await getOrCreateAssociatedTokenAccount(conn, payer, mint, sessionPda3, true);
  await mintTo(conn, payer, mint, sessionAta3.address, mintAuthority, 500_000n);
  const userAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, userWallet.publicKey, false);
  const attackerAta = await getOrCreateAssociatedTokenAccount(conn, payer, mint, attackerWallet.publicKey, false);

  // Read on-chain upgrade records (chain truth for registrations).
  const fwdPdAddr = programDataOf(FORWARDER);
  const fwdPd = await conn.getAccountInfo(fwdPdAddr);
  assert.ok(fwdPd, "forwarder ProgramData exists (deploy the mock first)");
  const fwdRec = parseProgramData(fwdPd.data);
  // SPL Token is immutable (deprecated-loader owner): evidence is the program
  // itself and the upgrade snapshot is empty. Assert the loader class so a
  // future reloader upgrade of Token would fail loudly here instead of silently.
  const tokenProg = await conn.getAccountInfo(TOKEN_PROGRAM_ID);
  assert.equal(tokenProg.owner.toBase58(), DEPRECATED_LOADER, "token loader class pinned");
  const tokRec = { hasAuth: false, auth: Buffer.alloc(32), slot: 0n };

  const vaultNonce = async () => (await conn.getAccountInfo(pda)).data.readBigUInt64LE(4);
  const registerIx = (sessPda, sessKey, game, evidence, expiresAt, hasAuth, auth, slot, nonce, expiry, sig) => new TransactionInstruction({
    keys: [
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: sessPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      { pubkey: evidence, isSigner: false, isWritable: false },
      { pubkey: game, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM,
    data: wdData(SESSION_DISC.register, [
      u64(nonce), sessKey.toBuffer(), game.toBuffer(), i64(expiresAt),
      Buffer.from([hasAuth ? 1 : 0]), auth, u64(slot), i64(expiry),
    ], sig.clientDataJSON),
  });
  const registerTx = (sessPda, sessKey, game, evidence, expiresAt, rec, nonce, expiry) => {
    const payload = registerPayload(accountId32, nonce, sessKey.toBuffer(), game.toBuffer(), expiresAt, rec.hasAuth, Buffer.from(rec.auth), rec.slot, expiry);
    const s = signPayload(owner, payload);
    return new Transaction().add(
      registerIx(sessPda, sessKey, game, evidence, expiresAt, rec.hasAuth, Buffer.from(rec.auth), rec.slot, nonce, expiry, s),
      buildSecpIx(s.comp, s.sig, s.messageData),
    );
  };
  // Session-execute builder: exact accounts (no remaining), vault never present.
  const execTx = (sessPda, sessSigner, game, evidence, seq, gameData, metas, gameAccts, protectedAddrs) => new Transaction().add(new TransactionInstruction({
    keys: [
      { pubkey: sessPda, isSigner: false, isWritable: true },
      { pubkey: game, isSigner: false, isWritable: false },
      { pubkey: evidence, isSigner: false, isWritable: false },
      { pubkey: sessSigner, isSigner: true, isWritable: false },
      ...gameAccts,
    ],
    programId: PROGRAM,
    data: Buffer.concat([
      Buffer.from([SESSION_DISC.execute]), u64(seq),
      u16(gameData.length), gameData,
      Buffer.from([metas.length]), ...metas.flatMap(([a, f]) => [a, f]),
      Buffer.from([protectedAddrs.length]), ...protectedAddrs.map((a) => a.toBuffer()),
    ]),
  }));
  const F = (writable, sessionSigner) => Buffer.from([(writable ? 0x01 : 0) | (sessionSigner ? 0x02 : 0)]);

  // ---- register sessionKp (game = forwarder) + session3 (game = token) ----
  const expiresAt = chainNow + 3600;
  const fwdEvidence = await evidenceOf(FORWARDER);
  await expectOk(registerTx(sessionPda, sessionKp.publicKey, FORWARDER, fwdEvidence, expiresAt, fwdRec, await vaultNonce(), exp()), [payer], "register session (forwarder game)");
  const tokEvidence = await evidenceOf(TOKEN_PROGRAM_ID);
  await expectOk(registerTx(sessionPda3, session3.publicKey, TOKEN_PROGRAM_ID, tokEvidence, expiresAt, tokRec, await vaultNonce(), exp()), [payer], "register session (token game)");
  {
    const d = (await conn.getAccountInfo(sessionPda)).data;
    assert.equal(d.length, 205, "session record len 205");
    assert.equal(d[0], 1, "session version 1");
    assert.equal(d[1], 0, "status active");
    assert.ok(Buffer.from(d.subarray(2, 34)).equals(sessionKp.publicKey.toBuffer()), "session key stored");
    assert.ok(Buffer.from(d.subarray(34, 66)).equals(accountId32), "account id stored");
    assert.equal(d.readBigUInt64LE(82), 0n, "seq 0");
    assert.ok(Buffer.from(d.subarray(90, 122)).equals(FORWARDER.toBuffer()), "allowed program stored");
    assert.equal(d.readBigUInt64LE(155), fwdRec.slot, "recorded slot matches chain");
    assert.equal(await vaultNonce(), 2n, "owner nonce consumed twice");
    results.push("PASS session record layout");
  }

  // ---- register with a lied upgrade snapshot → rejected (0x15) ----
  {
    const evilKp = Keypair.generate();
    const evilPda = sessionPdaOf(accountId32, evilKp.publicKey);
    const nonce = await vaultNonce();
    const liedSlot = fwdRec.slot + 1000n;
    const payload = registerPayload(accountId32, nonce, evilKp.publicKey.toBuffer(), FORWARDER.toBuffer(), expiresAt, fwdRec.hasAuth, Buffer.from(fwdRec.auth), liedSlot, exp());
    const s = signPayload(owner, payload);
    const tx = new Transaction().add(
      registerIx(evilPda, evilKp.publicKey, FORWARDER, fwdEvidence, expiresAt, fwdRec.hasAuth, Buffer.from(fwdRec.auth), liedSlot, nonce, exp(), s),
      buildSecpIx(s.comp, s.sig, s.messageData),
    );
    await expectErrCode(tx, [payer], "0x15", "lied upgrade snapshot rejected (SessionScopeViolation)");
  }

  const vaultBefore = (await conn.getAccountInfo(pda)).lamports;

  // ---- gameplay happy path: token transfer via session authority (seq 0) ----
  {
    const data = Buffer.concat([Buffer.from([3]), u64(100)]);
    const metas = [
      [sessionAta3.address.toBuffer(), F(true, false)],
      [userAta.address.toBuffer(), F(true, false)],
      [sessionPda3.toBuffer(), F(false, true)],
    ];
    const tx = execTx(sessionPda3, session3.publicKey, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, 0,
      data, metas, [
        { pubkey: sessionAta3.address, isSigner: false, isWritable: true },
        { pubkey: userAta.address, isSigner: false, isWritable: true },
      ], []);
    await expectOk(tx, [session3], "session token transfer (gameplay happy path)");
    assert.equal((await conn.getTokenAccountBalance(userAta.address)).value.amount, "100", "user got 100");
    const d = (await conn.getAccountInfo(sessionPda3)).data;
    assert.equal(d.readBigUInt64LE(82), 1n, "seq advanced");
    assert.equal(d.readBigUInt64LE(196), tokRec.slot, "last_seen slot refreshed");
    assert.equal((await conn.getAccountInfo(pda)).lamports, vaultBefore, "vault untouched by gameplay");
    results.push("PASS gameplay effects + upgrade-visibility snapshot");
  }

  // ---- ADV: vault named in a game CPI → rejected (0x15), vault untouched ----
  {
    const gameData = forwarderCall(SystemProgram.programId, systemTransferData(1000), [
      [pda, true, true], [userWallet.publicKey, false, true],
    ]);
    const metas = [
      [pda.toBuffer(), F(true, false)],
      [userWallet.publicKey.toBuffer(), F(true, false)],
    ];
    const tx = execTx(sessionPda, sessionKp.publicKey, FORWARDER, fwdPdAddr, 0,
      gameData, metas, [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: userWallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], []);
    await expectErrCode(tx, [sessionKp], "0x15", "vault in game CPI rejected (SessionScopeViolation)");
    assert.equal((await conn.getAccountInfo(pda)).lamports, vaultBefore, "vault balance unchanged");
  }

  // ---- ADV: forwarded signer moves session tokens only; vault immune ----
  // The forwarder reuses the lent session-PDA signer bit against the token
  // program — the honest forwarding residual. Vault assets cannot follow:
  // the vault is absent and unsigned.
  {
    const transferData = Buffer.concat([Buffer.from([3]), u64(50_000)]);
    const gameData = forwarderCall(TOKEN_PROGRAM_ID, transferData, [
      [sessionAta.address, false, true], [attackerAta.address, false, true], [sessionPda, true, false],
    ]);
    const metas = [
      [sessionPda.toBuffer(), F(false, true)],
      [sessionAta.address.toBuffer(), F(true, false)],
      [attackerAta.address.toBuffer(), F(true, false)],
      [TOKEN_PROGRAM_ID.toBuffer(), F(false, false)],
      [SystemProgram.programId.toBuffer(), F(false, false)],
    ];
    const tx = execTx(sessionPda, sessionKp.publicKey, FORWARDER, fwdPdAddr, 0,
      gameData, metas, [
        { pubkey: sessionAta.address, isSigner: false, isWritable: true },
        { pubkey: attackerAta.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], []);
    const before = BigInt((await conn.getTokenAccountBalance(attackerAta.address)).value.amount);
    await expectOk(tx, [sessionKp], "forwarded token drain executes (bounded residual)");
    const gained = BigInt((await conn.getTokenAccountBalance(attackerAta.address)).value.amount) - before;
    assert.equal(gained, 50_000n, "attacker got exactly the session's 50k");
    assert.equal((await conn.getAccountInfo(pda)).lamports, vaultBefore, "vault immune to forwarding");
    assert.equal((await conn.getTokenAccountBalance(vaultAta.address)).value.amount, vaultAtaStart, "vault tokens immune");
    results.push("PASS forwarding blast radius = session-owned tokens only");
  }

  // ---- ADV: same forwarded drain with the ATA protected → 0x15, nothing moves ----
  {
    const transferData = Buffer.concat([Buffer.from([3]), u64(10)]);
    const gameData = forwarderCall(TOKEN_PROGRAM_ID, transferData, [
      [sessionAta.address, false, true], [attackerAta.address, false, true], [sessionPda, true, false],
    ]);
    const metas = [
      [sessionPda.toBuffer(), F(false, true)],
      [sessionAta.address.toBuffer(), F(true, false)],
      [attackerAta.address.toBuffer(), F(true, false)],
      [TOKEN_PROGRAM_ID.toBuffer(), F(false, false)],
      [SystemProgram.programId.toBuffer(), F(false, false)],
    ];
    const before = (await conn.getTokenAccountBalance(attackerAta.address)).value.amount;
    const tx = execTx(sessionPda, sessionKp.publicKey, FORWARDER, fwdPdAddr, 1,
      gameData, metas, [
        { pubkey: sessionAta.address, isSigner: false, isWritable: true },
        { pubkey: attackerAta.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], [sessionAta.address]);
    await expectErrCode(tx, [sessionKp], "0x15", "protected ATA pins forwarded drain");
    assert.equal((await conn.getTokenAccountBalance(attackerAta.address)).value.amount, before, "nothing moved");
  }

  // ---- ADV: system debit of the session PDA fails closed (runtime rule) ----
  // "Transfer: `from` must not carry data" — session SOL is structurally immobile.
  {
    const gameData = forwarderCall(SystemProgram.programId, systemTransferData(500), [
      [sessionPda, true, true], [userWallet.publicKey, false, true],
    ]);
    const metas = [
      [sessionPda.toBuffer(), F(false, true)],
      [userWallet.publicKey.toBuffer(), F(true, false)],
      [SystemProgram.programId.toBuffer(), F(false, false)],
    ];
    const tx = execTx(sessionPda, sessionKp.publicKey, FORWARDER, fwdPdAddr, 1,
      gameData, metas, [
        { pubkey: userWallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], []);
    await expectErr(tx, [sessionKp], "system debit of data-carrying session PDA fails closed");
  }

  // ---- ADV: remaining_accounts rejected (extra account breaks exact count) ----
  {
    const transferData = Buffer.concat([Buffer.from([3]), u64(1)]);
    const gameData = forwarderCall(TOKEN_PROGRAM_ID, transferData, [
      [sessionAta.address, false, true], [attackerAta.address, false, true], [sessionPda, true, false],
    ]);
    const metas = [
      [sessionPda.toBuffer(), F(false, true)],
      [sessionAta.address.toBuffer(), F(true, false)],
      [attackerAta.address.toBuffer(), F(true, false)],
      [TOKEN_PROGRAM_ID.toBuffer(), F(false, false)],
      [SystemProgram.programId.toBuffer(), F(false, false)],
    ];
    const tx = execTx(sessionPda, sessionKp.publicKey, FORWARDER, fwdPdAddr, 1,
      gameData, metas, [
        { pubkey: sessionAta.address, isSigner: false, isWritable: true },
        { pubkey: attackerAta.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: userWallet.publicKey, isSigner: false, isWritable: false },
      ], []);
    await expectErr(tx, [sessionKp], "extra remaining account rejected");
  }

  // ---- token authority adversarial cases on session3 (seq continues at 1) ----
  {
    const attacker = attackerWallet.publicKey;
    // Approve(delegate=attacker) via session CPI, protected ATA → must revert, delegate stays None.
    const approveData = Buffer.concat([Buffer.from([4]), u64(100_000)]);
    const metas = [
      [sessionAta3.address.toBuffer(), F(true, false)],
      [attacker.toBuffer(), F(false, false)],
      [sessionPda3.toBuffer(), F(false, true)],
    ];
    const execToken = (seq, data, prot) => execTx(sessionPda3, session3.publicKey, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, seq,
      data, metas, [
        { pubkey: sessionAta3.address, isSigner: false, isWritable: true },
        { pubkey: attacker, isSigner: false, isWritable: false },
      ], prot);
    await expectErrCode(execToken(1, approveData, [sessionAta3.address]), [session3], "0x15", "protected delegate change caught (balance unchanged)");
    assert.equal((await conn.getTokenAccountBalance(sessionAta3.address)).value.amount, "499900", "no tokens moved");
    assert.equal((await conn.getAccountInfo(sessionAta3.address)).data.readUInt32LE(72), 0, "delegate still None");

    // Same approve WITHOUT protected listing → succeeds (sessions manage their own accounts).
    await expectOk(execToken(1, approveData, []), [session3], "unprotected session approve works (own account)");
    assert.equal((await conn.getAccountInfo(sessionAta3.address)).data.readUInt32LE(72), 1, "delegate now set");

    // Vault ATA transferFrom through a session → token program rejects (no vault signature).
    const transferData = Buffer.concat([Buffer.from([3]), u64(10)]);
    const metas3 = [
      [vaultAta.address.toBuffer(), F(true, false)],
      [sessionAta3.address.toBuffer(), F(true, false)],
      [sessionPda3.toBuffer(), F(false, true)],
    ];
    const tx3 = execTx(sessionPda3, session3.publicKey, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, 2,
      transferData, metas3, [
        { pubkey: vaultAta.address, isSigner: false, isWritable: true },
        { pubkey: sessionAta3.address, isSigner: false, isWritable: true },
      ], []);
    await expectErr(tx3, [session3], "vault token transferFrom fails (no vault signature)");
    assert.equal((await conn.getTokenAccountBalance(vaultAta.address)).value.amount, vaultAtaStart, "vault tokens unchanged");

    // Close-authority hijack on the session ATA (protected) → caught.
    const setAuthData = Buffer.concat([Buffer.from([6, 3, 1]), attacker.toBuffer()]);
    const metas4 = [
      [sessionAta3.address.toBuffer(), F(true, false)],
      [sessionPda3.toBuffer(), F(false, true)],
    ];
    const tx4 = execTx(sessionPda3, session3.publicKey, TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, 2,
      setAuthData, metas4, [
        { pubkey: sessionAta3.address, isSigner: false, isWritable: true },
      ], [sessionAta3.address]);
    await expectErrCode(tx4, [session3], "0x15", "protected close_authority change caught");
  }

  // ---- replay: seq advances once, replays die (0x14) ----
  {
    const transferData = Buffer.concat([Buffer.from([3]), u64(5)]);
    const gameData = forwarderCall(TOKEN_PROGRAM_ID, transferData, [
      [sessionAta.address, false, true], [attackerAta.address, false, true], [sessionPda, true, false],
    ]);
    const metas = [
      [sessionPda.toBuffer(), F(false, true)],
      [sessionAta.address.toBuffer(), F(true, false)],
      [attackerAta.address.toBuffer(), F(true, false)],
      [TOKEN_PROGRAM_ID.toBuffer(), F(false, false)],
      [SystemProgram.programId.toBuffer(), F(false, false)],
    ];
    const replayTx = () => execTx(sessionPda, sessionKp.publicKey, FORWARDER, fwdPdAddr, 1,
      gameData, metas, [
        { pubkey: sessionAta.address, isSigner: false, isWritable: true },
        { pubkey: attackerAta.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], []);
    await expectOk(replayTx(), [sessionKp], "seq 1 executes once");
    await expectErrCode(replayTx(), [sessionKp], "0x14", "same-seq replay rejected (BadSessionSeq)");
  }

  // ---- revoke → exec dies (0x12); close reclaims rent ----
  {
    const nonce = await vaultNonce();
    const payload = revokePayload(accountId32, sessionKp.publicKey.toBuffer(), nonce, exp());
    const s = signPayload(owner, payload);
    await expectOk(new Transaction().add(new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: sessionPda, isSigner: false, isWritable: true },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: wdData(SESSION_DISC.revoke, [u64(nonce), sessionKp.publicKey.toBuffer(), i64(exp())], s.clientDataJSON),
    }), buildSecpIx(s.comp, s.sig, s.messageData)), [backend], "revoke session");
    const transferData = Buffer.concat([Buffer.from([3]), u64(5)]);
    const gameData = forwarderCall(TOKEN_PROGRAM_ID, transferData, [
      [sessionAta.address, false, true], [attackerAta.address, false, true], [sessionPda, true, false],
    ]);
    const metas = [
      [sessionPda.toBuffer(), F(false, true)],
      [sessionAta.address.toBuffer(), F(true, false)],
      [attackerAta.address.toBuffer(), F(true, false)],
      [TOKEN_PROGRAM_ID.toBuffer(), F(false, false)],
      [SystemProgram.programId.toBuffer(), F(false, false)],
    ];
    const deadTx = execTx(sessionPda, sessionKp.publicKey, FORWARDER, fwdPdAddr, 2,
      gameData, metas, [
        { pubkey: sessionAta.address, isSigner: false, isWritable: true },
        { pubkey: attackerAta.address, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], []);
    await expectErrCode(deadTx, [sessionKp], "0x12", "revoked session rejected (SessionRevoked)");

    const closeTx = (sessPda, sessKey, dest, n, expiry, sig) => new Transaction().add(new TransactionInstruction({
      keys: [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: sessPda, isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: INSTRUCTIONS, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM,
      data: wdData(SESSION_DISC.close, [u64(n), sessKey.toBuffer(), i64(expiry)], sig.clientDataJSON),
    }), buildSecpIx(sig.comp, sig.sig, sig.messageData));
    const nonce2 = await vaultNonce();
    const cp = closePayload(accountId32, sessionKp.publicKey.toBuffer(), payer.publicKey.toBuffer(), nonce2, exp());
    const cs = signPayload(owner, cp);
    const destBalBefore = (await conn.getAccountInfo(payer.publicKey)).lamports;
    await expectOk(closeTx(sessionPda, sessionKp.publicKey, payer.publicKey, nonce2, exp(), cs), [backend], "close revoked session");
    assert.equal(await conn.getAccountInfo(sessionPda), null, "session account closed");
    assert.ok((await conn.getAccountInfo(payer.publicKey)).lamports > destBalBefore, "rent reclaimed");
  }

  // ---- expiry: 2-second session dies on the chain clock (0x13) ----
  {
    const shortKp = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(shortKp.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const shortPda = sessionPdaOf(accountId32, shortKp.publicKey);
    const now = await liveNow();
    const nonce = await vaultNonce();
    const payload = registerPayload(accountId32, nonce, shortKp.publicKey.toBuffer(), FORWARDER.toBuffer(), now + 2, fwdRec.hasAuth, Buffer.from(fwdRec.auth), fwdRec.slot, exp());
    const s = signPayload(owner, payload);
    await expectOk(new Transaction().add(
      registerIx(shortPda, shortKp.publicKey, FORWARDER, fwdEvidence, now + 2, fwdRec.hasAuth, Buffer.from(fwdRec.auth), fwdRec.slot, nonce, exp(), s),
      buildSecpIx(s.comp, s.sig, s.messageData),
    ), [payer], "short-lived session registered");
    await new Promise((r) => setTimeout(r, 3500));
    const gameData = forwarderCall(SystemProgram.programId, systemTransferData(1000), [
      [shortPda, true, true], [userWallet.publicKey, false, true],
    ]);
    const metas = [
      [shortPda.toBuffer(), F(false, true)],
      [userWallet.publicKey.toBuffer(), F(true, false)],
      [SystemProgram.programId.toBuffer(), F(false, false)],
    ];
    const tx = execTx(shortPda, shortKp.publicKey, FORWARDER, fwdPdAddr, 0,
      gameData, metas, [
        { pubkey: userWallet.publicKey, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ], []);
    await expectErrCode(tx, [shortKp], "0x13", "expired session rejected (SessionExpired)");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  for (const r of results) console.log(r);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
