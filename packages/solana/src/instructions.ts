// Transaction instruction builders for the Peridot smart-account program (task 006).
// The byte layouts MUST match `contracts/svm/smart-account/src/instructions/*`.
// Browser-safe: Uint8Array only (no Buffer).
//
// V2 (canonical — see contracts/V2_AUTHORIZATION.md): every builder takes the
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
import { concat, u16le, u64le, i64le, fromAscii, serializeExecuteCall } from "@peridotvault/pid-core";
import type { Bytes, ExecuteMeta } from "@peridotvault/pid-core";
import { IX, INSTRUCTIONS_SYSVAR, PID_PROGRAM_ID, SECP256R1_PRECOMPILE } from "@peridotvault/pid-core";

/** Build the passkey-signed `initialize(account_id, authority, clientDataJSON)` instruction (disc 0). */
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
 * Build the V2 passkey-signed `initialize(account_id, authority, rp_id_hash, clientDataJSON)`
 * instruction (disc 0). Writes v2 state (112B with RP-ID hash).
 */
export function buildInitializeInstructionV2(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  rpIdHash32: Uint8Array,
  payer: PublicKey,
  smartAccount: PublicKey,
  clientDataJSON: Uint8Array,
  programId: PublicKey = PID_PROGRAM_ID,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
  if (rpIdHash32.length !== 32) throw new Error("rpIdHash32 must be 32 bytes");
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.initialize], accountId32, authorityCompressed, rpIdHash32, u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
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
 * rp_id_hash | max_fee | policy | expiry | fee | clientDataJSON`. The program
 * enforces `fee ≤ max_fee` and splits base → relayer, markup → canonical
 * treasury. `treasury` must be the canonical `config::TREASURY`.
 */
export function buildActivateInstructionV2(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  rpIdHash32: Uint8Array,
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
  if (rpIdHash32.length !== 32) throw new Error("rpIdHash32 must be 32 bytes");
  return new TransactionInstruction({
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.activate], accountId32, authorityCompressed, rpIdHash32, u64le(maxFeeLamports), u16le(feePolicyVersion), i64le(expiry), u64le(feeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/**
 * Build the V3 `activate` instruction (disc 5): `account_id | authority |
 * rp_id_hash | policy | expiry | network_fee | clientDataJSON`. The program
 * recomputes `protocol_fee` from the signed policy and splits relayerFee →
 * relayer, protocolFee → canonical revenue vault.
 */
export function buildActivateInstructionV3(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  rpIdHash32: Uint8Array,
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
  if (rpIdHash32.length !== 32) throw new Error("rpIdHash32 must be 32 bytes");
  return new TransactionInstruction({
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId,
    data: concat([IX.activate], accountId32, authorityCompressed, rpIdHash32, u16le(feePolicyVersion), i64le(expiry), u64le(networkFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
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
