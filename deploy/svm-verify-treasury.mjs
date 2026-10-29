#!/usr/bin/env node
// ANT-869: read-only treasury verification — run BEFORE ANY funding.
//
// Asserts the config/treasury PDAs of <program-id> are initialized with
// exactly the expected operator as admins[0], and that no other writer can
// exist post-init (first-writer-wins: either PDA program-owned rejects a
// second InitTreasury with ConfigAlreadyInitialized).
//
// This script is READ-ONLY: it takes no keypair, sends no transactions, and
// is safe to run against any cluster (including mainnet) at any time. The
// operator runbook (deploy/README.md) gates ALL funding on this script
// exiting 0.
//
// Usage:
//   node deploy/svm-verify-treasury.mjs <program-id> \
//     --expected-admin <admin-pubkey-base58> \
//     [--rpc-url <url>] [--commitment confirmed]
//
// Exit codes:
//   0  PASS — config initialized, admins[0] == expected, treasury PDA
//      program-owned. Funding is allowed to proceed.
//   1  FAIL — named mismatch printed (uninitialized, wrong admin, bad owner,
//      bad shape). Do NOT fund. Recovery is in the runbook.

import { fileURLToPath } from "node:url";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import {
  CONFIG_LEN,
  CONFIG_VERSION_V1,
  OFF_ADMIN_COUNT,
  OFF_ADMINS,
  ADMIN_LEN,
  deriveConfigPda,
  deriveTreasuryPda,
} from "./svm-init-treasury-atomic.mjs";

function parseArgs(argv) {
  const out = {
    programId: null,
    expectedAdmin: null,
    rpcUrl: "http://127.0.0.1:8899",
    commitment: "confirmed",
  };
  const rest = [...argv];
  if (rest.length && !rest[0].startsWith("--")) out.programId = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = rest[i + 1];
    if (flag === "--expected-admin") out.expectedAdmin = next, i++;
    else if (flag === "--rpc-url") out.rpcUrl = next, i++;
    else if (flag === "--commitment") out.commitment = next, i++;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if (!out.programId) throw new Error("missing <program-id>");
  if (!out.expectedAdmin) throw new Error("missing --expected-admin <pubkey>");
  return out;
}

function fail(reason, detail) {
  console.error(`FAIL treasury verify: ${reason}`);
  if (detail) console.error(`  detail: ${detail}`);
  console.error("Do NOT fund. See deploy/README.md (SVM treasury runbook) for recovery.");
  return 1;
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`usage: svm-verify-treasury.mjs <program-id> --expected-admin <pubkey> [--rpc-url <url>] [--commitment <c>]`);
    console.error(`error: ${e.message}`);
    return 1;
  }
  const programId = new PublicKey(args.programId);
  const expected = new PublicKey(args.expectedAdmin);
  const [config] = deriveConfigPda(programId);
  const [treasury] = deriveTreasuryPda(programId);
  console.error(`program:  ${programId.toBase58()}`);
  console.error(`expected: ${expected.toBase58()} (admins[0])`);
  console.error(`config:   ${config.toBase58()}`);
  console.error(`treasury: ${treasury.toBase58()}`);
  console.error(`rpc:      ${args.rpcUrl}`);

  const conn = new Connection(args.rpcUrl, args.commitment);
  const cfg = await conn.getAccountInfo(config).catch((e) => {
    console.error(`error: RPC getAccountInfo(config) failed: ${e.message ?? e}`);
    return undefined;
  });
  if (cfg === undefined) return fail("RPC unreachable", "getAccountInfo(config) threw");
  if (cfg === null) {
    return fail(
      "config PDA uninitialized",
      "init_treasury never landed — run deploy/svm-deploy-init-atomic.sh first",
    );
  }
  if (cfg.owner.toBase58() !== programId.toBase58()) {
    return fail(
      "config owner is not the program",
      `owner=${cfg.owner.toBase58()} (split-brain deploy or squatted PDA?)`,
    );
  }
  if (cfg.data.length !== CONFIG_LEN) {
    return fail("config wrong length", `len=${cfg.data.length} want=${CONFIG_LEN}`);
  }
  if (cfg.data[0] !== CONFIG_VERSION_V1) {
    return fail("config wrong version", `version=${cfg.data[0]} want=${CONFIG_VERSION_V1}`);
  }
  if (cfg.data[OFF_ADMIN_COUNT] < 1) {
    return fail("config admin_count is zero", "no admin set — unusable vault");
  }
  const admin0 = new PublicKey(cfg.data.subarray(OFF_ADMINS, OFF_ADMINS + ADMIN_LEN));
  if (!admin0.equals(expected)) {
    return fail(
      "admins[0] is not the expected operator",
      `admins[0]=${admin0.toBase58()} (race lost or wrong operator — redeploy under a FRESH program keypair)`,
    );
  }
  const vault = await conn.getAccountInfo(treasury).catch(() => undefined);
  if (vault === undefined) return fail("RPC unreachable", "getAccountInfo(treasury) threw");
  if (!vault) return fail("treasury PDA missing", "config exists but treasury does not — partial init?");
  if (vault.owner.toBase58() !== programId.toBase58()) {
    return fail(
      "treasury owner is not the program",
      `owner=${vault.owner.toBase58()}`,
    );
  }
  console.log(`OK treasury verified: admins[0]==${expected.toBase58()}, treasury program-owned, no second init possible (first-writer-wins).`);
  return 0;
}

const invokedAsScript = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
