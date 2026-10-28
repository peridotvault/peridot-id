#!/usr/bin/env node
// ANT-806: atomic treasury init for the SVM production deploy flow.
//
// One operator execution, back-to-back with the program deploy, using the SAME
// operator keypair as initer AND initial admin (ANT-801 H3: on-chain enforces
// `initial_admin == initer`, Unauthorized otherwise). First-writer-wins is
// still the tiebreak — anyone winning the deploy->init race self-appoints and
// owns the fee stream via WithdrawRevenue. This script closes that window by
// running init in the same operator execution as the deploy, then verifying
// the config PDA before declaring success.
//
// Usage:
//   node deploy/svm-init-treasury-atomic.mjs <program-id> \
//     --operator-keypair <operator-keypair.json> \
//     [--rpc-url <url>] [--commitment confirmed]
//
// Exit codes:
//   0  init is yours (fresh init, or config already exists with admins[0] == operator)
//   2  usage / keypair / config error (nothing sent)
//   3  RACE LOST — config exists and admins[0] != operator. Alert, do NOT retry
//      init; recovery is redeploy under a FRESH program id (see runbook note).
//   4  post-init verify mismatch (init landed but config is not as expected)
//   5  RPC / send / confirm failure (state unknown — re-run; pre-check makes
//      this safe: a retry either completes init or reports already-yours/race-lost)
//
// Safety rules:
// - The operator keypair file is read, never printed. Only pubkeys enter logs.
// - No delegated appoint flag exists on purpose: client-side fail-fast mirrors
//   the on-chain H3 binding (genesis appoints self only).
// - No mainnet execution without a board order (ANT-806).

import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ---- Canonical constants (must match contracts/svm/smart-account) ----
export const INIT_TREASURY_DISC = 15;
export const CONFIG_SEED = "config";
export const TREASURY_SEED = "treasury";
export const CONFIG_LEN = 264;
export const CONFIG_VERSION_V1 = 1;
export const OFF_ADMIN_COUNT = 1;
export const OFF_ADMINS = 8;
export const ADMIN_LEN = 32;

export function deriveConfigPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId);
}

export function deriveTreasuryPda(programId) {
  return PublicKey.findProgramAddressSync([Buffer.from(TREASURY_SEED)], programId);
}

// ANT-801 H3 client-side fail-fast: genesis appoints self only.
export function buildSelfInitTreasuryIx(operatorPubkey, programId) {
  const [config] = deriveConfigPda(programId);
  const [treasury] = deriveTreasuryPda(programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: operatorPubkey, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data: Buffer.concat([Buffer.from([INIT_TREASURY_DISC]), operatorPubkey.toBytes()]),
  });
}

// Verify the config PDA belongs to `operatorPubkey`. Throws with a message
// naming the exact mismatch (caller maps to exit 3/4). Returns "fresh" when
// the account does not exist yet (init still needed).
export async function checkConfigOwnership(conn, programId, operatorPubkey) {
  const [config] = deriveConfigPda(programId);
  const [treasury] = deriveTreasuryPda(programId);
  const cfg = await conn.getAccountInfo(config);
  if (!cfg) return { state: "uninitialized", config, treasury };
  assert.equal(cfg.data.length, CONFIG_LEN, `config len ${cfg.data.length} != ${CONFIG_LEN}`);
  assert.equal(cfg.data[0], CONFIG_VERSION_V1, `config version ${cfg.data[0]} != ${CONFIG_VERSION_V1}`);
  assert.ok(cfg.data[OFF_ADMIN_COUNT] >= 1, "config admin_count must be >= 1");
  assert.equal(
    cfg.owner.toBase58(),
    programId.toBase58(),
    "config owner is not the program (split-brain deploy?)",
  );
  const admin0 = new PublicKey(cfg.data.subarray(OFF_ADMINS, OFF_ADMINS + ADMIN_LEN));
  if (!admin0.equals(operatorPubkey)) {
    return { state: "race-lost", config, treasury, admin0 };
  }
  const vault = await conn.getAccountInfo(treasury);
  assert.ok(vault, "treasury PDA missing while config exists");
  assert.equal(vault.owner.toBase58(), programId.toBase58(), "treasury owner is not the program");
  return { state: "yours", config, treasury };
}

function parseArgs(argv) {
  const out = { programId: null, operatorKeypair: null, rpcUrl: "http://127.0.0.1:8899", commitment: "confirmed" };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith("--")) out.programId = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = rest[i + 1];
    if (flag === "--operator-keypair") out.operatorKeypair = next, i++;
    else if (flag === "--rpc-url") out.rpcUrl = next, i++;
    else if (flag === "--commitment") out.commitment = next, i++;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!out.programId) throw new Error("missing <program-id>");
  if (!out.operatorKeypair) throw new Error("missing --operator-keypair <path>");
  return out;
}

function loadOperatorKeypair(path) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read operator keypair file: ${path} (${e.message})`);
  }
  const secret = Uint8Array.from(raw);
  if (secret.length !== 64) throw new Error("operator keypair file must hold 64 secret bytes");
  return Keypair.fromSecretKey(secret);
}

async function main(argv, connOverride) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`usage: svm-init-treasury-atomic.mjs <program-id> --operator-keypair <path> [--rpc-url <url>] [--commitment <c>]`);
    console.error(`error: ${e.message}`);
    return 2;
  }
  const programId = new PublicKey(args.programId);
  const operator = loadOperatorKeypair(args.operatorKeypair);
  console.error(`program:  ${programId.toBase58()}`);
  console.error(`operator: ${operator.publicKey.toBase58()} (initer == initial_admin, ANT-801 H3)`);
  console.error(`rpc:      ${args.rpcUrl}`);

  const conn = connOverride ?? new Connection(args.rpcUrl, args.commitment);

  // Pre-check: idempotent retry if a previous run initialized with THIS
  // operator; hard abort if someone else won the race.
  const before = await checkConfigOwnership(conn, programId, operator.publicKey).catch((e) => {
    console.error(`ALERT pre-check failed: ${e.message}`);
    return null;
  });
  if (!before) return 5;
  if (before.state === "yours") {
    console.log("OK treasury already initialized with operator as admins[0] (idempotent retry, nothing sent).");
    return 0;
  }
  if (before.state === "race-lost") {
    console.error(`ALERT RACE LOST: config admins[0] is ${before.admin0.toBase58()}, not the operator.`);
    console.error("ALERT A frontrunner won deploy->init and owns the fee stream. Do NOT retry init.");
    console.error("ALERT Recovery: redeploy under a FRESH program keypair, then re-run the atomic flow.");
    return 3;
  }

  // Fresh chain: send init_treasury back-to-back in this operator execution.
  let sig;
  try {
    sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(buildSelfInitTreasuryIx(operator.publicKey, programId)),
      [operator],
      { commitment: args.commitment },
    );
  } catch (e) {
    console.error(`ALERT init_treasury send/confirm failed: ${e.message ?? e}`);
    console.error("State unknown — re-run this script (pre-check makes retry safe).");
    return 5;
  }
  console.error(`init_treasury signature: ${sig}`);

  // Post-verify before declaring success.
  try {
    const after = await checkConfigOwnership(conn, programId, operator.publicKey);
    if (after.state !== "yours") {
      console.error(`ALERT post-init verify: config admins[0] is not the operator (state=${after.state}).`);
      return after.state === "race-lost" ? 3 : 4;
    }
  } catch (e) {
    console.error(`ALERT post-init verify failed: ${e.message}`);
    return 4;
  }
  console.log("OK treasury initialized: config admins[0] == operator, treasury PDA program-owned.");
  return 0;
}

const invokedAsScript = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
