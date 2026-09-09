// Transaction instruction builders for the Peridot smart-account program (task 006).
// The byte layouts MUST match `programs/peridot-smart-account/src/instructions/*`.
// Browser-safe: Uint8Array only (no Buffer).

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
import { concat, u16le, u64le, i64le, fromAscii } from "@peridotvault/pid-core";
import type { Bytes } from "@peridotvault/pid-core";
import { IX, INSTRUCTIONS_SYSVAR, PID_PROGRAM_ID, SECP256R1_PRECOMPILE } from "@peridotvault/pid-core";

/** Build the `initialize(account_id, authority)` instruction (disc 0). */
export function buildInitializeInstruction(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  payer: PublicKey,
  smartAccount: PublicKey,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PID_PROGRAM_ID,
    data: concat([IX.initialize], accountId32, authorityCompressed) as unknown as Buffer,
  });
}

/**
 * Build the `activate(account_id, authority, activation_fee)` instruction (disc 5).
 * Peridot-sponsored activation: relayer claims the (possibly pre-funded) PDA, then the
 * activation fee is reimbursed from the smart account to `treasury`.
 */
export function buildActivateInstruction(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  activationFeeLamports: bigint,
  relayer: PublicKey,
  smartAccount: PublicKey,
  treasury: PublicKey,
): TransactionInstruction {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  if (authorityCompressed.length !== 33) throw new Error("authority must be the 33-byte compressed pubkey");
  return new TransactionInstruction({
    keys: [
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PID_PROGRAM_ID,
    data: concat([IX.activate], accountId32, authorityCompressed, u64le(activationFeeLamports)) as unknown as Buffer,
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
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: treasury, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId: PID_PROGRAM_ID,
    data: concat([IX.withdrawSol], u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry), u64le(relayFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
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
    programId: PID_PROGRAM_ID,
    data: concat([IX.withdrawToken], u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry), u64le(relayFeeLamports), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
  });
}

/** `update_authority(nonce, new_authority, expiry)`. */
export function buildUpdateAuthorityInstruction(
  smartAccount: PublicKey,
  nonce: bigint,
  newAuthorityCompressed: Uint8Array,
  expiry: number,
  clientDataJSON: Uint8Array,
): TransactionInstruction {
  if (newAuthorityCompressed.length !== 33) throw new Error("new authority must be 33 bytes");
  return new TransactionInstruction({
    keys: [
      { pubkey: smartAccount, isSigner: false, isWritable: true },
      { pubkey: INSTRUCTIONS_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId: PID_PROGRAM_ID,
    data: concat([IX.updateAuthority], u64le(nonce), newAuthorityCompressed, i64le(expiry), u16le(clientDataJSON.length), clientDataJSON) as unknown as Buffer,
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