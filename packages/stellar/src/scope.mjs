// Canonical scope descriptor builder — T3 parity with
// contracts/stellar/phase0-experiments/src/rules.rs `scope_canonical` / `scope_hash` (ANT-703).
//
// Layout (fixed-width, length-prefixed, field-ordered):
//   class_tag NUL ‖ n_contracts u32le ‖ contracts (32B each, granted order) ‖
//   n_fns u32le ‖ (fn_len u16le ‖ fn_bytes)*
//
// Any divergence from the Rust layout breaks the golden parity tests in
// test/scope.test.mjs — that is intentional (fail the build, not mainnet).
import { createHash } from 'node:crypto';

export const RULE_CLASS_TAGS = Object.freeze({
  StateRead: 'state-read',
  GameMove: 'game-move',
  ProfileWrite: 'profile-write',
  SessionAdminReadonly: 'session-admin-readonly',
});

export const MAX_RULE_FNS = 64;
export const MAX_FN_BYTES = 64;
export const MAX_CONTRACTS = 64;

export class ScopeTooLarge extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeTooLarge';
    this.code = 'SCOPE_TOO_LARGE';
  }
}

/** Programmer error (bad class tag, malformed contract hex) — distinct from oversize. */
export class ScopeInvalid extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScopeInvalid';
    this.code = 'SCOPE_INVALID';
  }
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function u16le(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

/**
 * @param {string} classTag one of RULE_CLASS_TAGS values (validated — finding 4, ANT-704)
 * @param {string[]} contractHexes 64-char lowercase hex strings (32B each, granted order, ≤64)
 * @param {string[]} fns function names (utf-8, ≤64 bytes each, ≤64 entries)
 * @returns {Buffer} canonical descriptor bytes
 * @throws {ScopeInvalid} on unknown class tag or malformed contract hex (programmer error)
 * @throws {ScopeTooLarge} on oversize descriptors (fail-closed at build)
 */
export function scopeCanonical(classTag, contractHexes, fns) {
  if (!Object.values(RULE_CLASS_TAGS).includes(classTag)) {
    throw new ScopeInvalid(`unknown rule class tag: ${String(classTag).slice(0, 32)}`);
  }
  if (contractHexes.length > MAX_CONTRACTS) {
    throw new ScopeTooLarge(`too many contracts: ${contractHexes.length} > ${MAX_CONTRACTS}`);
  }
  if (fns.length > MAX_RULE_FNS) throw new ScopeTooLarge(`too many fns: ${fns.length} > ${MAX_RULE_FNS}`);
  for (const f of fns) {
    if (Buffer.byteLength(f, 'utf8') > MAX_FN_BYTES) {
      throw new ScopeTooLarge(`fn name too long (${Buffer.byteLength(f, 'utf8')}B > ${MAX_FN_BYTES}B)`);
    }
  }
  const parts = [Buffer.from(classTag, 'utf8'), Buffer.from([0x00]), u32le(contractHexes.length)];
  for (const h of contractHexes) {
    if (!/^[0-9a-f]{64}$/.test(h)) throw new ScopeInvalid(`contract must be 64-char hex: ${String(h).slice(0, 16)}…`);
    parts.push(Buffer.from(h, 'hex'));
  }
  parts.push(u32le(fns.length));
  for (const f of fns) {
    const fb = Buffer.from(f, 'utf8');
    parts.push(u16le(fb.length), fb);
  }
  return Buffer.concat(parts);
}

/** sha256 hex over {@link scopeCanonical} bytes. */
export function scopeHash(classTag, contractHexes, fns) {
  return createHash('sha256').update(scopeCanonical(classTag, contractHexes, fns)).digest('hex');
}
