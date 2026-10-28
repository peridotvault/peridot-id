// Transaction instruction builders for the Peridot smart-account program (task 006).
// The byte layouts MUST match `contracts/svm/smart-account/src/instructions/*`.
// Browser-safe: Uint8Array only (no Buffer).
//
// V2 (frozen legacy — see contracts/WHITEPAPER.md §2): every builder takes the
// program id explicitly (no silent derivation/submission split) and builds the V2
// layouts with `max_fee` + `fee_policy_version` + attested `fee`. V1 builders are
// kept frozen for legacy verification only.

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { concat, u16le, u64le, i64le, fromAscii, serializeExecuteCall, serializeSessionMetas } from "@peridotvault/pid-core";
import type { Bytes, ExecuteMeta, SessionMeta } from "@peridotvault/pid-core";
import { IX, IX_SESSION, IX_V4, IX_VAULT, TREASURY_SEED, CONFIG_SEED, INSTRUCTIONS_SYSVAR, PID_PROGRAM_ID, SECP256R1_PRECOMPILE, MAX_PROTECTED } from "@peridotvault/pid-core";

/**
 * Build the passkey-signed `initialize(account_id, authority, clientDataJSON)` instruction (disc 0).
 *
 * @deprecated ANT-16(e) (board fee decision d4ebecff): direct `initialize`
 * bypasses the 50% sponsored-creation fee — `activate` (builders below) is
 * the sole production creation path. Production builds reject this
 * instruction with `InitializeDeprecated`. Kept for testnet/devnet only.
 */
export function buildInitializeInstruction(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  payer: PublicKey,
  smartAccount: PublicKey,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.initialize], accountId32, authorityCompressed, u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Build the V2 passkey-signed `initialize(account_id, authority, clientDataJSON)`
 * instruction (disc 0). Writes v2 state (80B, domain-free).
 *
 * @deprecated ANT-16(e) (board fee decision d4ebecff): direct `initialize`
 * bypasses the 50% sponsored-creation fee — `activate` (builders below) is
 * the sole production creation path. Production builds reject this
 * instruction with `InitializeDeprecated`. Kept for testnet/devnet only.
 */
export function buildInitializeInstructionV2(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  payer: PublicKey,
  smartAccount: PublicKey,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.initialize], accountId32, authorityCompressed, u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Build the passkey-signed `activate(account_id, authority, activation_fee, expiry, clientDataJSON)`
 * instruction (disc 5). Peridot-sponsored activation: relayer claims the (possibly pre-funded)
 * PDA, then the activation fee is reimbursed from the smart account to `treasury`.
 */
export function buildActivateInstruction(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  activationFeeLamports: bigint,
  relayer: PublicKey,
  smartAccount: PublicKey,
  treasury: PublicKey,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.activate], accountId32, authorityCompressed, u64le(activationFeeLamports), i64le(expiry), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Build the V2 `activate` instruction (disc 5): `account_id | authority |
 * max_fee | policy | expiry | fee | clientDataJSON`. The program
 * enforces `fee ≤ max_fee` and splits base → relayer, markup → canonical
 * treasury. `treasury` must be the canonical `config::TREASURY`.
 */
export function buildActivateInstructionV2(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  maxFeeLamports: bigint,
  feePolicyVersion: number,
  expiry: number,
  feeLamports: bigint,
  relayer: PublicKey,
  smartAccount: PublicKey,
  treasury: PublicKey,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.activate], accountId32, authorityCompressed, u64le(maxFeeLamports), u16le(feePolicyVersion), i64le(expiry), u64le(feeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Build the V3 `activate` instruction (disc 5): `account_id | authority |
 * policy | expiry | network_fee | clientDataJSON`. The program
 * recomputes `protocol_fee` from the signed policy and splits relayerFee →
 * relayer, protocolFee → canonical revenue vault.
 */
export function buildActivateInstructionV3(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  feePolicyVersion: number,
  expiry: number,
  networkFeeLamports: bigint,
  relayer: PublicKey,
  smartAccount: PublicKey,
  treasury: PublicKey,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.activate], accountId32, authorityCompressed, u16le(feePolicyVersion), i64le(expiry), u64le(networkFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Build the Secp256r1 precompile instruction that carries the passkey signature.
 * Layout: [num_sigs=1][pad=0][offsets 14B][pubkey 33B @16][signature 64B @49][message @113].
 */
export function buildSecp256r1Instruction(
  pubkeyCompressed: Uint8Array,
  signature: Uint8Array, // 64B r‖s
  messageData: Uint8Array,
): TransactionInstruction {
  if (pubkeyCompressed.length !== 33) throw new Error("pubkey must be 33 bytes");
  if (signature.length !== 64) throw new Error("signature must be 64 bytes");
  const offsets = new Uint8Array(14);
  new DataView(offsets.buffer).setUint16(0, 49, true); // signature_offset
  new DataView(offsets.buffer).setUint16(2, 0xffff, true);
  new DataView(offsets.buffer).setUint16(4, 16, true); // pubkey_offset
  new DataView(offsets.buffer).setUint16(6, 0xffff, true);
  new DataView(offsets.buffer).setUint16(8, 113, true); // message_data_offset
  new DataView(offsets.buffer).setUint16(10, messageData.length, true);
  new DataView(offsets.buffer).setUint16(12, 0xffff, true);
  return new TransactionInstruction({
    keys: [],
    programId: SECP256R1_PRECOMPILE,
    data: concat([1, 0], offsets, pubkeyCompressed, signature, messageData) as unknown as Buffer,
  });
}

/**
 * Sponsored `withdraw_sol(nonce, amount, destination, expiry, relay_fee)` — must be followed
 * by the secp256r1 ix. The Peridot relayer is the tx signer/fee payer and `treasury` receives
 * the reimbursed relay fee (network fee × (1 + margin)) from the smart account.
 */
export function buildWithdrawSolInstruction(
  smartAccount: PublicKey,
  destination: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  amount: bigint,
  relayFeeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.withdrawSol], u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry), u64le(relayFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V2 `withdraw_sol`: `nonce | amount | destination | expiry | max_fee |
 * policy | fee | clientDataJSON`. The program enforces `fee ≤ max_fee` and splits
 * base → relayer, markup → canonical treasury. `treasury` must be canonical.
 */
export function buildWithdrawSolInstructionV2(
  smartAccount: PublicKey,
  destination: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  amount: bigint,
  maxFeeLamports: bigint,
  feePolicyVersion: number,
  feeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.withdrawSol], u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry), u64le(maxFeeLamports), u16le(feePolicyVersion), u64le(feeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored `withdraw_token(nonce, amount, destination_ata, expiry, relay_fee)`. The relay
 * fee (SOL) is reimbursed from the smart account to the treasury; the token transfer runs
 * through the SPL Token program via CPI.
 */
export function buildWithdrawTokenInstruction(
  smartAccount: PublicKey,
  sourceAta: PublicKey,
  destinationAta: PublicKey,
  mint: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  amount: bigint,
  relayFeeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
    ],
    programId,
    data: concat([IX.withdrawToken], u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry), u64le(relayFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V2 `withdraw_token` with `max_fee | policy | fee`. The program asserts
 * the source ATA is owned by the PDA for `mint` and splits base → relayer,
 * markup → canonical treasury.
 */
export function buildWithdrawTokenInstructionV2(
  smartAccount: PublicKey,
  sourceAta: PublicKey,
  destinationAta: PublicKey,
  mint: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  amount: bigint,
  maxFeeLamports: bigint,
  feePolicyVersion: number,
  feeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
    ],
    programId,
    data: concat([IX.withdrawToken], u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry), u64le(maxFeeLamports), u16le(feePolicyVersion), u64le(feeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V4 `withdraw_sol` (disc 11, ANT-544 B5, ANT-556): `nonce | amount |
 * destination | expiry | policy | network_fee | max_total_fee | clientDataJSON`.
 * The program recomputes `protocol_fee` from the signed policy (v1 frozen row,
 * v2 with the 17_000-lamport floor) and enforces
 * `network_fee + protocol_fee ≤ max_total_fee` (`FeeExceedsMax`).
 * Layout MUST match `withdraw_sol_v4.rs` byte-for-byte.
 */
export function buildWithdrawSolInstructionV4(
  smartAccount: PublicKey,
  destination: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  amount: bigint,
  feePolicyVersion: number,
  networkFeeLamports: bigint,
  maxTotalFeeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX_V4.withdrawSol], u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry), u16le(feePolicyVersion), u64le(networkFeeLamports), u64le(maxTotalFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V4 `withdraw_token` (disc 12): as V3 plus `max_total_fee` after
 * `network_fee`. Layout MUST match `withdraw_token_v4.rs` byte-for-byte.
 */
export function buildWithdrawTokenInstructionV4(
  smartAccount: PublicKey,
  sourceAta: PublicKey,
  destinationAta: PublicKey,
  mint: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  amount: bigint,
  feePolicyVersion: number,
  networkFeeLamports: bigint,
  maxTotalFeeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
    ],
    programId,
    data: concat([IX_V4.withdrawToken], u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry), u16le(feePolicyVersion), u64le(networkFeeLamports), u64le(maxTotalFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V4 `activate` (disc 14): `account_id | authority | policy | expiry |
 * network_fee | max_total_fee | clientDataJSON`. Layout MUST match
 * `activate_v4.rs` byte-for-byte.
 */
export function buildActivateInstructionV4(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  feePolicyVersion: number,
  expiry: number,
  networkFeeLamports: bigint,
  maxTotalFeeLamports: bigint,
  relayer: PublicKey,
  smartAccount: PublicKey,
  treasury: PublicKey,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX_V4.activate], accountId32, authorityCompressed, u16le(feePolicyVersion), i64le(expiry), u64le(networkFeeLamports), u64le(maxTotalFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V4 `execute` (disc 13): V3 call bytes plus `max_total_fee` after
 * `network_fee`. Same call-confinement checks as V3 (PDA-signer proof, exact
 * account coverage, fail-fast here and on-chain). Layout MUST match
 * `execute_v4.rs` byte-for-byte.
 */
export function buildExecuteInstructionV4(
  smartAccount: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  target: PublicKey,
  metas: ExecuteMeta[],
  data: Uint8Array,
  feePolicyVersion: number,
  networkFeeLamports: bigint,
  maxTotalFeeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (target.equals(programId)) throw new Error("execute target cannot be the smart-account program");
  const smartStr = smartAccount.toBase58();
  const relayerStr = relayer.toBase58();
  for (const m of metas) {
    if (m.signer && m.address.toBase58() !== smartStr && m.address.toBase58() !== relayerStr) {
      throw new Error(`execute signer meta must be the PDA or relayer: ${m.address.toBase58()}`);
    }
  }
  const call = serializeExecuteCall(target, metas, data);
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: target, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      // The PDA is never an outer signer (it signs the CPI via seeds); every
      // other meta mirrors its bound flags outward so the CPI privilege check passes.
      ...metas.map((m) => ({
        pubkey: m.address,
        isSigner: m.signer && m.address.toBase58() === relayerStr,
        isWritable: m.writable,
      })),
    ],
    programId,
    data: concat([IX_V4.execute], u64le(nonce), call, i64le(expiry), u16le(feePolicyVersion), u64le(networkFeeLamports), u64le(maxTotalFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V3 `withdraw_sol`: `nonce | amount | destination | expiry | policy |
 * network_fee | clientDataJSON`. The program recomputes `protocol_fee` from the
 * signed policy and splits relayerFee (`= networkFee`) → relayer, protocolFee →
 * canonical revenue vault. No amounts are signed — see V3 spec §4.
 */
export function buildWithdrawSolInstructionV3(
  smartAccount: PublicKey,
  destination: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  amount: bigint,
  feePolicyVersion: number,
  networkFeeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.withdrawSol], u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry), u16le(feePolicyVersion), u64le(networkFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V3 `withdraw_token` with `policy | network_fee`. The program asserts
 * the source ATA is owned by the PDA for `mint` and splits relayerFee →
 * relayer, protocolFee → canonical revenue vault.
 */
export function buildWithdrawTokenInstructionV3(
  smartAccount: PublicKey,
  sourceAta: PublicKey,
  destinationAta: PublicKey,
  mint: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  amount: bigint,
  feePolicyVersion: number,
  networkFeeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destinationAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
    ],
    programId,
    data: concat([IX.withdrawToken], u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry), u16le(feePolicyVersion), u64le(networkFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/** `update_authority(nonce, new_authority, expiry)`. Ix layout is unchanged in V2
 *  (the V2 binding lives in the signed challenge: op-tag ‖ account_id ‖ …). */
export function buildUpdateAuthorityInstruction(
  smartAccount: PublicKey,
  nonce: bigint,
  newAuthorityCompressed: Uint8Array,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (newAuthorityCompressed.length !== 33) throw new Error("new authority must be 33 bytes");
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.updateAuthority], u64le(nonce), newAuthorityCompressed, i64le(expiry), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/** V2 `close(nonce, expiry, clientDataJSON)` (disc 4). No SDK caller existed in V1;
 *  provided so teardown is constructible and testable. */
export function buildCloseInstruction(
  smartAccount: PublicKey,
  destination: PublicKey,
  nonce: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.close], u64le(nonce), i64le(expiry), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Sponsored V3 `execute` (disc 6): `nonce | target | meta_count | metas | data |
 * expiry | policy | network_fee | clientDataJSON`. Fully generic CPI — any target
 * except the program itself — with the PDA as signer. The passkey signs
 * `call_hash` over the canonical call bytes (see `serializeExecuteCall`); the
 * program re-verifies it, so the relayer cannot substitute target/metas/data.
 * Every meta with the signer bit must be the PDA or the relayer (nothing else
 * can sign the outer transaction) — enforced here, fail-fast.
 */
export function buildExecuteInstructionV3(
  smartAccount: PublicKey,
  treasury: PublicKey,
  relayer: PublicKey,
  nonce: bigint,
  target: PublicKey,
  metas: ExecuteMeta[],
  data: Uint8Array,
  feePolicyVersion: number,
  networkFeeLamports: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (target.equals(programId)) throw new Error("execute target cannot be the smart-account program");
  const smartStr = smartAccount.toBase58();
  const relayerStr = relayer.toBase58();
  for (const m of metas) {
    if (m.signer && m.address.toBase58() !== smartStr && m.address.toBase58() !== relayerStr) {
      throw new Error(`execute signer meta must be the PDA or relayer: ${m.address.toBase58()}`);
    }
  }
  const call = serializeExecuteCall(target, metas, data);
    assertCanonicalTreasury(treasury, programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: target, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      // The PDA is never an outer signer (it signs the CPI via seeds); every
      // other meta mirrors its bound flags outward so the CPI privilege check passes.
      ...metas.map((m) => ({
        pubkey: m.address,
        isSigner: m.signer && m.address.toBase58() === relayerStr,
        isWritable: m.writable,
      })),
    ],
    programId,
    data: concat([IX.execute], u64le(nonce), call, i64le(expiry), u16le(feePolicyVersion), u64le(networkFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/** Deposit (top-up): plain SOL transfer into the smart account — no program instruction (PRD_v5 §4). */
export function buildDepositSolInstruction(
  from: PublicKey,
  smartAccount: PublicKey,
  lamports: bigint,
): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: smartAccount, lamports: Number(lamports) });
}

/** The smart account's Associated Token Account for `mint` (owner = the PDA). */
export function smartAccountAta(smartAccount: PublicKey, mint: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, smartAccount, true);
}

/**
 * Deposit (top-up) an SPL token into the smart account: idempotent ATA creation (when the
 * account is missing) + a plain transfer. Returns the instructions and the ATA address.
 */
export async function buildDepositTokenInstruction(
  fromAta: PublicKey,
  smartAccount: PublicKey,
  mint: PublicKey,
  amount: bigint,
  payer: PublicKey,
  ataExists: boolean,
): Promise<{ ixs: TransactionInstruction[]; ata: PublicKey }> {
  const ata = await smartAccountAta(smartAccount, mint);
  const ixs: TransactionInstruction[] = [];
  if (!ataExists) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, smartAccount, mint));
  }
  ixs.push(createTransferInstruction(fromAta, ata, fromAta, Number(amount)));
  return { ixs, ata };
}

export type { Bytes };
export { fromAscii };

/**
 * Session PDA creation is program-side (`registerSession` does the system
 * `create_account` CPI signed with the session seeds — a PDA cannot sign a
 * client-side create). There is intentionally no client builder for it.
 */

/**
 * Owner-signed `registerSession` (disc 7): binds an Ed25519 session key + one
 * allowlisted game program (+ its verified upgrade snapshot) to a fresh
 * session PDA. The program creates the PDA itself (exact rent-exempt minimum,
 * floated by `payer`); consumes the vault's owner nonce. One P-256 ceremony
 * per session lifetime — never per gameplay action.
 * `gameProgramData` is the game's ProgramData for upgradeable games, or the
 * game program itself for immutable ones (native/deprecated loader).
 */
export function buildRegisterSessionInstruction(
  vault: PublicKey,
  sessionPda: PublicKey,
  gameProgramData: PublicKey,
  gameProgram: PublicKey,
  payer: PublicKey,
  nonce: bigint,
  sessionPubkey: PublicKey,
  allowedProgram: PublicKey,
  expiresAt: number,
  recordedHasAuthority: boolean,
  recordedAuthority: Uint8Array,
  recordedSlot: bigint,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (recordedAuthority.length !== 32) throw new Error("recordedAuthority must be 32 bytes");
  if (allowedProgram.equals(programId)) throw new Error("session game cannot be the smart-account program");
  if (!allowedProgram.equals(gameProgram)) throw new Error("game program account must equal the allowlisted program");
  return new TransactionInstruction({
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: gameProgramData, isSigner: false, isWritable: false },
      { pubkey: gameProgram, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat(
      [IX_SESSION.registerSession],
      u64le(nonce),
      sessionPubkey.toBytes(),
      allowedProgram.toBytes(),
      i64le(expiresAt),
      [recordedHasAuthority ? 1 : 0],
      recordedAuthority,
      u64le(recordedSlot),
      i64le(expiry),
      u16le(clientDataJSON.length),
      clientDataJSON,
    ) as unknown as Buffer,
  });
}

/**
 * Session-signed `sessionExecute` (disc 8): one gameplay CPI authorized by the
 * session keypair (tx envelope signer) + on-chain record (seq, expiry,
 * inactivity). The vault PDA must not appear anywhere — enforced here
 * fail-fast and on-chain. No `remaining_accounts`: `gameAccounts` must cover
 * every non-session meta exactly once, in order.
 */
export function buildSessionExecuteInstruction(
  sessionPda: PublicKey,
  gameProgram: PublicKey,
  gameProgramData: PublicKey,
  sessionSigner: PublicKey,
  vault: PublicKey,
  seq: bigint,
  gameData: Uint8Array,
  metas: SessionMeta[],
  gameAccounts: { address: PublicKey; writable: boolean }[],
  protectedAccounts: PublicKey[],
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (gameProgram.equals(programId)) throw new Error("session target cannot be the smart-account program");
  const sessionStr = sessionPda.toBase58();
  const vaultStr = vault.toBase58();
  let sessionSigns = false;
  const forwarded: { address: PublicKey; writable: boolean }[] = [];
  for (const m of metas) {
    if (m.address.toBase58() === vaultStr) throw new Error("vault PDA must never enter a session CPI");
    if (m.sessionSigner) {
      if (m.address.toBase58() !== sessionStr) throw new Error("only the session PDA carries the session-signer bit");
      sessionSigns = true;
    } else {
      forwarded.push({ address: m.address, writable: m.writable });
    }
  }
  if (!sessionSigns) throw new Error("at least one meta must carry the session-PDA signer");
  if (forwarded.length !== gameAccounts.length) throw new Error("gameAccounts must cover every non-session meta exactly once");
  forwarded.forEach((f, i) => {
    if (!f.address.equals(gameAccounts[i].address)) throw new Error(`game account ${i} out of order`);
    if (f.address.toBase58() === vaultStr) throw new Error("vault PDA must never enter a session CPI");
  });
  if (protectedAccounts.length > MAX_PROTECTED) throw new Error(`too many protected accounts (${protectedAccounts.length})`);
  for (const p of protectedAccounts) {
    if (!metas.some((m) => m.address.equals(p))) throw new Error("protected accounts must be a subset of the metas");
  }
  return new TransactionInstruction({
    keys: [
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: gameProgram, isSigner: false, isWritable: false },
      { pubkey: gameProgramData, isSigner: false, isWritable: false },
      { pubkey: sessionSigner, isSigner: true, isWritable: false },
      ...gameAccounts.map((a) => ({ pubkey: a.address, isSigner: false, isWritable: a.writable })),
    ],
    programId,
    data: concat(
      [IX_SESSION.sessionExecute],
      u64le(seq),
      u16le(gameData.length),
      gameData,
      serializeSessionMetas(metas),
      [protectedAccounts.length & 0xff],
      ...protectedAccounts.map((p) => p.toBytes()),
    ) as unknown as Buffer,
  });
}

/** Owner-signed `revokeSession` (disc 9): immediate, consumes the owner nonce. */
export function buildRevokeSessionInstruction(
  vault: PublicKey,
  sessionPda: PublicKey,
  nonce: bigint,
  sessionPubkey: PublicKey,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat(
      [IX_SESSION.revokeSession],
      u64le(nonce),
      sessionPubkey.toBytes(),
      i64le(expiry),
      u16le(clientDataJSON.length),
      clientDataJSON,
    ) as unknown as Buffer,
  });
}

/** Owner-signed `closeSession` (disc 10): revoked/expired only, rent to `destination`. */
export function buildCloseSessionInstruction(
  vault: PublicKey,
  sessionPda: PublicKey,
  destination: PublicKey,
  nonce: bigint,
  sessionPubkey: PublicKey,
  expiry: number,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (destination.equals(sessionPda)) throw new Error("close destination must differ from the session PDA");
  return new TransactionInstruction({
    keys: [
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: sessionPda, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat(
      [IX_SESSION.closeSession],
      u64le(nonce),
      sessionPubkey.toBytes(),
      i64le(expiry),
      u16le(clientDataJSON.length),
      clientDataJSON,
    ) as unknown as Buffer,
  });
}

/* ------------------------------------------------------------------ */
/* ANT-635 program-bound revenue vault (disc 15-18).                   */
/*                                                                     */
/* The protocol fee lands in the `[b"treasury"]` PDA vault, derived    */
/* from the program id at runtime — there is no treasury const or env  */
/* anymore. These builders derive the PDAs internally (exact §5a       */
/* account orderings); the `treasury` params on the legacy fee         */
/* builders above are migration-validated against the derived PDA.     */
/* ------------------------------------------------------------------ */

function seedBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Derive the `[b"treasury"]` PDA vault for a program id. */
export function deriveTreasuryPda(
  programId: PublicKey = PID_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([seedBytes(TREASURY_SEED)], programId);
}

/** Derive the `[b"config"]` revenue-config PDA for a program id. */
export function deriveRevenueConfigPda(
  programId: PublicKey = PID_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([seedBytes(CONFIG_SEED)], programId);
}

/**
 * Migration validator for the legacy explicit-`treasury` params: throws
 * unless the passed address equals the derived `[b"treasury"]` PDA.
 * (The program enforces this on-chain too — fail-closed both sides.)
 */
export function assertCanonicalTreasury(
  treasury: PublicKey,
  programId: PublicKey = PID_PROGRAM_ID,
): void {
  const [expected] = deriveTreasuryPda(programId);
  if (!treasury.equals(expected)) {
    throw new Error(
      `treasury must be the canonical ["treasury"] PDA ${expected.toBase58()} (ANT-635)`,
    );
  }
}

/**
 * Build `InitTreasury(initial_admin)` (disc 15). Accounts (§5a):
 * `[initer signer/writable, config PDA writable, treasury PDA writable,
 * system program]`. No auth payload — ANT-801 (H3): `initialAdmin` MUST
 * equal `initer` (genesis appoints self only; on-chain enforces with
 * `Unauthorized`). The initer funds rent AND becomes `admins[0]` atomically.
 */
export function buildInitTreasuryInstruction(
  initer: PublicKey,
  initialAdmin: PublicKey,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (!initer.equals(initialAdmin)) {
    throw new Error("initTreasury: initialAdmin must equal initer (ANT-801 H3)");
  }
  const [config] = deriveRevenueConfigPda(programId);
  const [treasury] = deriveTreasuryPda(programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: initer, isSigner: true, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX_VAULT.initTreasury], initialAdmin.toBytes()) as unknown as Buffer,
  });
}

/**
 * Build `WithdrawRevenue(amount)` (disc 16). Accounts (§5a):
 * `[treasury writable, config writable, admin signer/writable,
 * destination writable]`. Never drains below the 0-byte rent-exempt floor.
 */
export function buildWithdrawRevenueInstruction(
  admin: PublicKey,
  destination: PublicKey,
  amountLamports: bigint,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  const [config] = deriveRevenueConfigPda(programId);
  const [treasury] = deriveTreasuryPda(programId);
  if (destination.equals(treasury) || destination.equals(config)) {
    throw new Error("withdraw destination must not be the vault or config PDA (D2)");
  }
  return new TransactionInstruction({
    keys: [
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
    ],
    programId,
    data: concat([IX_VAULT.withdrawRevenue], u64le(amountLamports)) as unknown as Buffer,
  });
}

/**
 * Build `AddAdmin(new_admin)` (disc 17). Accounts (§5a):
 * `[config writable, existing admin signer/writable]`.
 */
export function buildAddAdminInstruction(
  admin: PublicKey,
  newAdmin: PublicKey,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  const [config] = deriveRevenueConfigPda(programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: true },
    ],
    programId,
    data: concat([IX_VAULT.addAdmin], newAdmin.toBytes()) as unknown as Buffer,
  });
}

/**
 * Build `RemoveAdmin(admin)` (disc 18). Accounts (§5a):
 * `[config writable, existing admin signer/writable]`. Floor-1 enforced
 * on-chain (`CannotRemoveLastAdmin`).
 */
export function buildRemoveAdminInstruction(
  admin: PublicKey,
  target: PublicKey,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  const [config] = deriveRevenueConfigPda(programId);
  return new TransactionInstruction({
    keys: [
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: true },
    ],
    programId,
    data: concat([IX_VAULT.removeAdmin], target.toBytes()) as unknown as Buffer,
  });
}
