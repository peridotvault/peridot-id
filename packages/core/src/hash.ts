// Shared Solana constants and pure helpers for the Peridot smart-account program.
//
// The instruction/account layouts here MUST match `contracts/svm/smart-account/src`
// exactly — a mismatch fails on-chain. Task 005's integration suite is the cross-check.
// Browser-safe: no Buffer, no node:crypto (WebCrypto for SHA-256).

import { PublicKey } from "@solana/web3.js";
import { concat, fromAscii, pidToSeed32, sha256 as hashSha256, u16le, u64le, i64le } from "./bytes";
import type { Bytes } from "./bytes";

export { pidToSeed32 };

export const PID_PROGRAM_ID = new PublicKey("CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT");
export const SECP256R1_PRECOMPILE = new PublicKey("Secp256r1SigVerify1111111111111111111111111");
export const INSTRUCTIONS_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");

/** Domain separator for the signed authorization payload (PRD_v4 §25). */
export const DOMAIN = fromAscii("PID|SOLANA|SMART_ACCOUNT|v1");
/** V2 domain (frozen). V1 payloads can never verify as V2. */
export const DOMAIN_V2 = fromAscii("PID|SOLANA|SMART_ACCOUNT|v2");
/** V3 domain (canonical). V2 payloads can never verify as V3. */
export const DOMAIN_V3 = fromAscii("PID|SOLANA|SMART_ACCOUNT|v3");

/** V2 operation tags — first payload byte after the domain (match program discriminators). */
export const OP = {
  initialize: 0,
  withdrawSol: 1,
  withdrawToken: 2,
  updateAuthority: 3,
  close: 4,
  activate: 5,
  execute: 6,
} as const;

/** Instruction discriminators (must match `src/instructions/mod.rs`). */
export const IX = {
  initialize: 0,
  withdrawSol: 1,
  withdrawToken: 2,
  updateAuthority: 3,
  close: 4,
  activate: 5,
  execute: 6,
} as const;

/** Execute meta flags (bit 0 = writable, bit 1 = signer) — match `execute.rs`. */
export const EXECUTE_FLAG = { writable: 1, signer: 2 } as const;

/** Protocol-level execute caps — match `execute.rs` (tx size binds first in practice). */
export const MAX_EXECUTE_METAS = 64;
export const MAX_EXECUTE_DATA = 10_240;

/** One bound account of a generic execute call. */
export interface ExecuteMeta {
  address: PublicKey;
  writable: boolean;
  signer: boolean;
}

export function sha256(data: Uint8Array): Promise<Uint8Array> {
  return hashSha256(data);
}

export async function base64url(data: Uint8Array): Promise<string> {
  const { b64url } = await import("./bytes");
  return b64url(data);
}

/** Derive the smart-account PDA: seeds ["peridot_id", "account", sha256(pid)]. */
export function deriveSmartAccountAddress(pid: string, programId: PublicKey = PID_PROGRAM_ID): {
  address: PublicKey;
  bump: number;
} {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("peridot_id"), Buffer.from("account"), pidToSeed32(pid) as unknown as Buffer],
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

/** Convenience for the common WITHDRAW_SOL payload (fee recipient bound — cannot be swapped). */
export async function buildWithdrawPayload(
  nonce: bigint,
  amount: bigint,
  destination: PublicKey,
  expiry: number,
  relayFeeLamports: bigint = 0n,
  treasury: PublicKey,
): Promise<Uint8Array> {
  return buildAuthorizationPayload([u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry), u64le(relayFeeLamports), treasury.toBytes()]);
}

/** WITHDRAW_TOKEN payload: also binds the treasury and the debited source ATA. */
export async function buildWithdrawTokenPayload(
  nonce: bigint,
  amount: bigint,
  destinationAta: PublicKey,
  expiry: number,
  relayFeeLamports: bigint,
  treasury: PublicKey,
  sourceAta: PublicKey,
): Promise<Uint8Array> {
  return buildAuthorizationPayload([u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry), u64le(relayFeeLamports), treasury.toBytes(), sourceAta.toBytes()]);
}

/** INITIALIZE payload: only the new authority itself can claim the PDA (no squat). */
export async function buildInitializePayload(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
): Promise<Uint8Array> {
  return buildAuthorizationPayload([accountId32, authorityCompressed]);
}

/** ACTIVATE payload: binds the claim, the fee, its expiry, and the fee recipient. */
export async function buildActivatePayload(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  activationFeeLamports: bigint,
  expiry: number,
  treasury: PublicKey,
): Promise<Uint8Array> {
  return buildAuthorizationPayload([accountId32, authorityCompressed, u64le(activationFeeLamports), i64le(expiry), treasury.toBytes()]);
}

/**
 * The exact bytes a WebAuthn passkey signs: `authenticatorData ‖ sha256(clientDataJSON)`.
 * This becomes the secp256r1 precompile's `message_data`.
 */
export async function buildWebAuthnMessage(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Promise<Uint8Array> {
  return concat(authenticatorData, await hashSha256(clientDataJSON));
}

// ---------------------------------------------------------------------------
// V2 builders (frozen legacy — see contracts/WHITEPAPER.md §2).
// Every payload starts with the one-byte op-tag followed by the 32-byte
// account_id, so cross-account and cross-operation replay is impossible.
// `maxFee` is the user-signed absolute cap; `fee` itself travels unattested in
// instruction data and is enforced on-chain as `fee ≤ maxFee`.
// ---------------------------------------------------------------------------

/** V2 payload hash: `sha256(DOMAIN_V2 ‖ opTag ‖ parts…)`. */
export async function buildAuthorizationPayloadV2(opTag: number, parts: Uint8Array[]): Promise<Uint8Array> {
  return hashSha256(concat(DOMAIN_V2, new Uint8Array([opTag & 0xff]), ...parts));
}

/** V2 WITHDRAW_SOL payload. */
export async function buildWithdrawPayloadV2(
  accountId32: Uint8Array,
  nonce: bigint,
  amount: bigint,
  destination: PublicKey,
  expiry: number,
  maxFeeLamports: bigint,
  feePolicyVersion: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV2(OP.withdrawSol, [
    accountId32, u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry),
    u64le(maxFeeLamports), u16le(feePolicyVersion),
  ]);
}

/** V2 WITHDRAW_TOKEN payload (also binds the debited source ATA). */
export async function buildWithdrawTokenPayloadV2(
  accountId32: Uint8Array,
  nonce: bigint,
  amount: bigint,
  destinationAta: PublicKey,
  expiry: number,
  maxFeeLamports: bigint,
  feePolicyVersion: number,
  sourceAta: PublicKey,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV2(OP.withdrawToken, [
    accountId32, u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry),
    u64le(maxFeeLamports), u16le(feePolicyVersion), sourceAta.toBytes(),
  ]);
}

/** V2 INITIALIZE payload (also binds the RP-ID hash). */
export async function buildInitializePayloadV2(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  rpIdHash32: Uint8Array,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV2(OP.initialize, [accountId32, authorityCompressed, rpIdHash32]);
}

/** V2 ACTIVATE payload (also binds the RP-ID hash and the fee cap). */
export async function buildActivatePayloadV2(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  rpIdHash32: Uint8Array,
  maxFeeLamports: bigint,
  feePolicyVersion: number,
  expiry: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV2(OP.activate, [
    accountId32, authorityCompressed, rpIdHash32, u64le(maxFeeLamports),
    u16le(feePolicyVersion), i64le(expiry),
  ]);
}

/** V2 UPDATE_AUTHORITY payload. */
export async function buildUpdateAuthorityPayloadV2(
  accountId32: Uint8Array,
  nonce: bigint,
  newAuthorityCompressed: Uint8Array,
  expiry: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV2(OP.updateAuthority, [
    accountId32, u64le(nonce), newAuthorityCompressed, i64le(expiry),
  ]);
}

/** V2 CLOSE payload. */
export async function buildClosePayloadV2(
  accountId32: Uint8Array,
  nonce: bigint,
  destination: PublicKey,
  expiry: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV2(OP.close, [
    accountId32, u64le(nonce), destination.toBytes(), i64le(expiry),
  ]);
}

// ---------------------------------------------------------------------------
// V3 builders (canonical — see contracts/WHITEPAPER.md §§2, 6).
// Same account/op binding as V2, but fee amounts are gone from payloads: the
// user authorizes the intent plus a `feePolicyVersion` only. The backend attests
// `networkFee` at submit time; the program recomputes `protocolFee` from the
// immutable policy table and enforces the split on-chain.
// ---------------------------------------------------------------------------

/** V3 payload hash: `sha256(DOMAIN_V3 ‖ opTag ‖ parts…)`. */
export async function buildAuthorizationPayloadV3(opTag: number, parts: Uint8Array[]): Promise<Uint8Array> {
  return hashSha256(concat(DOMAIN_V3, new Uint8Array([opTag & 0xff]), ...parts));
}

/** V3 WITHDRAW_SOL payload (no fee amounts — policy version only). */
export async function buildWithdrawPayloadV3(
  accountId32: Uint8Array,
  nonce: bigint,
  amount: bigint,
  destination: PublicKey,
  expiry: number,
  feePolicyVersion: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV3(OP.withdrawSol, [
    accountId32, u64le(nonce), u64le(amount), destination.toBytes(), i64le(expiry),
    u16le(feePolicyVersion),
  ]);
}

/** V3 WITHDRAW_TOKEN payload (also binds the debited source ATA). */
export async function buildWithdrawTokenPayloadV3(
  accountId32: Uint8Array,
  nonce: bigint,
  amount: bigint,
  destinationAta: PublicKey,
  expiry: number,
  feePolicyVersion: number,
  sourceAta: PublicKey,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV3(OP.withdrawToken, [
    accountId32, u64le(nonce), u64le(amount), destinationAta.toBytes(), i64le(expiry),
    u16le(feePolicyVersion), sourceAta.toBytes(),
  ]);
}

/** V3 INITIALIZE payload (also binds the RP-ID hash). */
export async function buildInitializePayloadV3(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  rpIdHash32: Uint8Array,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV3(OP.initialize, [accountId32, authorityCompressed, rpIdHash32]);
}

/** V3 ACTIVATE payload (also binds the RP-ID hash and the fee policy). */
export async function buildActivatePayloadV3(
  accountId32: Uint8Array,
  authorityCompressed: Uint8Array,
  rpIdHash32: Uint8Array,
  feePolicyVersion: number,
  expiry: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV3(OP.activate, [
    accountId32, authorityCompressed, rpIdHash32,
    u16le(feePolicyVersion), i64le(expiry),
  ]);
}

/** V3 UPDATE_AUTHORITY payload. */
export async function buildUpdateAuthorityPayloadV3(
  accountId32: Uint8Array,
  nonce: bigint,
  newAuthorityCompressed: Uint8Array,
  expiry: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV3(OP.updateAuthority, [
    accountId32, u64le(nonce), newAuthorityCompressed, i64le(expiry),
  ]);
}

/** V3 CLOSE payload. */
export async function buildClosePayloadV3(
  accountId32: Uint8Array,
  nonce: bigint,
  destination: PublicKey,
  expiry: number,
): Promise<Uint8Array> {
  return buildAuthorizationPayloadV3(OP.close, [
    accountId32, u64le(nonce), destination.toBytes(), i64le(expiry),
  ]);
}

/**
 * Canonical execute-call bytes: `target ‖ meta_count u8 ‖ metas(addr32 ‖ flags u8) ‖
 * data_len u16 ‖ data`. The program hashes exactly this region as `call_hash`;
 * serialize once here, reuse for the payload and the instruction.
 */
export function serializeExecuteCall(
  target: PublicKey,
  metas: ExecuteMeta[],
  data: Uint8Array,
): Uint8Array {
  if (metas.length > MAX_EXECUTE_METAS) throw new Error(`too many execute metas (${metas.length})`);
  if (data.length > MAX_EXECUTE_DATA) throw new Error(`execute data too large (${data.length})`);
  const parts: (Uint8Array | number[])[] = [target.toBytes(), [metas.length & 0xff]];
  for (const m of metas) {
    parts.push(m.address.toBytes(), [(m.writable ? EXECUTE_FLAG.writable : 0) | (m.signer ? EXECUTE_FLAG.signer : 0)]);
  }
  return concat(...parts, u16le(data.length), data);
}

/** `call_hash` for an execute: `sha256` over the canonical call bytes. */
export async function executeCallHash(
  target: PublicKey,
  metas: ExecuteMeta[],
  data: Uint8Array,
): Promise<Uint8Array> {
  return hashSha256(serializeExecuteCall(target, metas, data));
}

/** V3 EXECUTE payload: op-tag ‖ account ‖ nonce ‖ expiry ‖ policy ‖ call_hash (no amounts). */
export async function buildExecutePayloadV3(
  accountId32: Uint8Array,
  nonce: bigint,
  expiry: number,
  feePolicyVersion: number,
  callHash32: Uint8Array,
): Promise<Uint8Array> {
  if (callHash32.length !== 32) throw new Error("callHash32 must be 32 bytes");
  return buildAuthorizationPayloadV3(OP.execute, [
    accountId32, u64le(nonce), i64le(expiry), u16le(feePolicyVersion), callHash32,
  ]);
}

// ================= Session layer (ADR-010, EVM V4 counterpart) =================
//
// Session keys are Ed25519: the P-256 passkey authorizes registration once via
// the precompile, then gameplay authorization is the session keypair signing
// the transaction envelope plus on-chain record checks. Layouts MUST match
// `contracts/svm/smart-account/src/instructions/{register_session,session_execute,revoke_session,close_session}.rs`.

/** Session-grant domain (canonical). Disjoint from every SMART_ACCOUNT domain. */
export const DOMAIN_SESSION = fromAscii("PID|SOLANA|SESSION|v1");

/** Session operation tags (match program discriminators 7-10). */
export const OP_SESSION = {
  registerSession: 7,
  sessionExecute: 8,
  revokeSession: 9,
  closeSession: 10,
} as const;

/** Session instruction discriminators (must match `src/instructions/mod.rs`). */
export const IX_SESSION = {
  registerSession: 7,
  sessionExecute: 8,
  revokeSession: 9,
  closeSession: 10,
} as const;

/** Session record length — match `state.rs::SESSION_STATE_LEN`. */
export const SESSION_STATE_LEN = 205;
/** Maximum session lifetime, seconds (24h) — match `auth::SESSION_MAX_TTL_SECS`. */
export const SESSION_MAX_TTL_SECS = 86_400;
/** Session inactivity timeout, seconds (30min) — match `auth::SESSION_INACTIVITY_SECS`. */
export const SESSION_INACTIVITY_SECS = 1_800;

/** Session-execute meta flags (bit 0 = writable, bit 1 = session-PDA-signer). */
export const SESSION_FLAG = { writable: 1, sessionSigner: 2 } as const;

/** Session-execute bounds — match `session_execute.rs` (tx size binds first). */
export const MAX_SESSION_METAS = 32;
export const MAX_SESSION_DATA = 1_024;
export const MAX_PROTECTED = 8;

/** BPF upgradeable loader (ProgramData derivation + owner check). */
export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Derive the session PDA: seeds ["peridot_id", "session", account_id, session_pubkey]. */
export function deriveSessionAddress(
  accountId32: Uint8Array,
  sessionPubkey: PublicKey,
  programId: PublicKey = PID_PROGRAM_ID,
): { address: PublicKey; bump: number } {
  if (accountId32.length !== 32) throw new Error("accountId32 must be 32 bytes");
  const [address, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("peridot_id"), Buffer.from("session"), accountId32 as unknown as Buffer, sessionPubkey.toBytes() as unknown as Buffer],
    programId,
  );
  return { address, bump };
}

/** Derive a game's ProgramData address: PDA [program_id] under the upgradeable loader. */
export function deriveProgramDataAddress(programId: PublicKey): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [programId.toBytes() as unknown as Buffer],
    BPF_LOADER_UPGRADEABLE,
  );
  return { address, bump };
}

/** Session-grant payload hash: `sha256(DOMAIN_SESSION ‖ opTag ‖ parts…)` (challenge). */
export async function buildSessionPayload(opTag: number, parts: Uint8Array[]): Promise<Uint8Array> {
  return hashSha256(concat(DOMAIN_SESSION, new Uint8Array([opTag & 0xff]), ...parts));
}

function u8le(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}

/** REGISTER_SESSION payload: op ‖ account ‖ nonce ‖ session_key ‖ program ‖ expires_at ‖ rec. */
export async function buildRegisterSessionPayload(args: {
  accountId32: Uint8Array;
  nonce: bigint;
  sessionPubkey: PublicKey;
  allowedProgram: PublicKey;
  expiresAt: number;
  recordedHasAuthority: boolean;
  recordedAuthority: Uint8Array;
  recordedSlot: bigint;
  expiry: number;
}): Promise<Uint8Array> {
  if (args.recordedAuthority.length !== 32) throw new Error("recordedAuthority must be 32 bytes");
  return buildSessionPayload(OP_SESSION.registerSession, [
    args.accountId32,
    u64le(args.nonce),
    args.sessionPubkey.toBytes(),
    args.allowedProgram.toBytes(),
    i64le(args.expiresAt),
    u8le(args.recordedHasAuthority ? 1 : 0),
    args.recordedAuthority,
    u64le(args.recordedSlot),
    i64le(args.expiry),
  ]);
}

/** REVOKE_SESSION payload: op ‖ account ‖ session_key ‖ nonce ‖ expiry. */
export async function buildRevokeSessionPayload(args: {
  accountId32: Uint8Array;
  sessionPubkey: PublicKey;
  nonce: bigint;
  expiry: number;
}): Promise<Uint8Array> {
  return buildSessionPayload(OP_SESSION.revokeSession, [
    args.accountId32,
    args.sessionPubkey.toBytes(),
    u64le(args.nonce),
    i64le(args.expiry),
  ]);
}

/** CLOSE_SESSION payload: op ‖ account ‖ session_key ‖ destination ‖ nonce ‖ expiry. */
export async function buildCloseSessionPayload(args: {
  accountId32: Uint8Array;
  sessionPubkey: PublicKey;
  destination: PublicKey;
  nonce: bigint;
  expiry: number;
}): Promise<Uint8Array> {
  return buildSessionPayload(OP_SESSION.closeSession, [
    args.accountId32,
    args.sessionPubkey.toBytes(),
    args.destination.toBytes(),
    u64le(args.nonce),
    i64le(args.expiry),
  ]);
}

/** One bound account of a session gameplay call. */
export interface SessionMeta {
  address: PublicKey;
  writable: boolean;
  /** True only for the session PDA itself (the delegation proof). */
  sessionSigner: boolean;
}

/** Serialize session-execute metas: `meta_count u8 ‖ metas(addr32 ‖ flags u8)`. */
export function serializeSessionMetas(metas: SessionMeta[]): Uint8Array {
  if (metas.length === 0 || metas.length > MAX_SESSION_METAS) {
    throw new Error(`session metas must be 1..${MAX_SESSION_METAS}`);
  }
  const parts: (Uint8Array | number[])[] = [[metas.length & 0xff]];
  for (const m of metas) {
    parts.push(m.address.toBytes(), [(m.writable ? SESSION_FLAG.writable : 0) | (m.sessionSigner ? SESSION_FLAG.sessionSigner : 0)]);
  }
  return concat(...parts);
}

export { Bytes };