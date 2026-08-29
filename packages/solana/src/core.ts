// Shared Solana constants and pure helpers for the Peridot smart-account program.
//
// The instruction/account layouts here MUST match `programs/peridot-smart-account/src`
// exactly — a mismatch fails on-chain. Task 005's integration suite is the cross-check.
// Browser-safe: no Buffer, no node:crypto (WebCrypto for SHA-256).

import { PublicKey } from "@solana/web3.js";
import { concat, fromAscii, sha256 as hashSha256, u64le, i64le } from "./bytes";
import type { Bytes } from "./bytes";

export const PERIDOT_PROGRAM_ID = new PublicKey("G8tPCQRqZAg5R2TDGkcRKw8vZN3tJMdtyHGbaQhW5o4G");
export const SECP256R1_PRECOMPILE = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
export const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

/** Domain separator for the signed authorization payload (PRD_v4 §25). */
export const DOMAIN = fromAscii("PERIDOT|SOLANA|SMART_ACCOUNT|v1");

/** Instruction discriminators (must match `src/instructions/mod.rs`). */
export const IX = {
  initialize: 0,
  withdrawSol: 1,
  withdrawToken: 2,
  updateAuthority: 3,
  close: 4,
} as const;

export function sha256(data: Uint8Array): Promise<Uint8Array> {
  return hashSha256(data);
}

export async function base64url(data: Uint8Array): Promise<string> {
  const { b64url } = await import("./bytes");
  return b64url(data);
}

/**
 * The 32-byte seed for a smart account PDA: the zero-padded 16-byte UUID of a
 * peridot_accounts.id (ADR 004 §5 — matches task 002's derivation).
 */
export function accountIdToSeed32(accountId: string): Uint8Array {
  const hex = accountId.replace(/-/g, "");
  if (hex.length !== 32) throw new Error(`invalid account id: ${accountId}`);
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return concat(new Uint8Array(16), bytes);
}

/** Derive the smart-account PDA: seeds ["peridot", "account", seed32]. */
export function deriveSmartAccountAddress(accountId: string, programId: PublicKey = PERIDOT_PROGRAM_ID): {
  address: PublicKey;
  bump: number;
} {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("peridot"), Buffer.from("account"), accountIdToSeed32(accountId) as unknown as Buffer],
    programId,
  );
  return { address, bump };
}

/**
 * Domain-separated authorization payload hash — the value the SDK puts in the WebAuthn
 * challenge. Must match `auth::payload_hash` in the program.
 */
export async function buildAuthorizationPayload(parts: Uint8Array[]): Promise<Uint8Array> {
  return hashSha256(concat(DOMAIN, ...parts));
}

/** Convenience for the common WITHDRAW_SOL payload. */
export async function buildWithdrawPayload(
  nonce: bigint,
  amount: bigint,
  destination: PublicKey,
  expiry: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayload([u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry)]);
}

/**
 * The exact bytes a WebAuthn passkey signs: `authenticatorData ‖ sha256(clientDataJSON)`.
 * This becomes the secp256r1 precompile's `message_data`.
 */
export async function buildWebAuthnMessage(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Promise<Uint8Array> {
  return concat(authenticatorData, await hashSha256(clientDataJSON));
}

export { Bytes };