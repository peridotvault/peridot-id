import { createHash } from "node:crypto";

// PDA derivation for the Peridot smart account (ADR 004 §5, ADR 007 §2).
//
// Seeds: ["peridot", "account", account_id_32] where account_id_32 is the zero-padded
// 32-byte representation of the peridot_accounts.id UUID. The program id is configurable
// (PERIDOT_PROGRAM_ID). Canonical Solana findProgramAddress: sha256("ProgramDerivedAddress"
// + seeds + program_id + bump), bump descending 255..0 until the resulting address is an
// off-curve Ed25519 point (guaranteeing the PDA cannot have a private key).
//
// Reference vectors are cross-checked against @solana/web3.js findProgramAddressSync in
// account.service.spec.ts (task 002 shared vectors; packages/solana revalidates in task 006).

const PDA_MARKER = "ProgramDerivedAddress";
const P = (1n << 255n) - 19n; // ed25519 field prime
// ed25519 curve constant d = -121665/121666 mod p
const D = (P - ((121665n * modInverse(121666n, P)) % P)) % P;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export interface SmartAccountAddress {
  address: string;
  bump: number;
}

/** UUID string (e.g. a peridot_accounts.id) → its 16 raw bytes, zero-padded to 32. */
export function uuidTo32(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, "");
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length !== 16) throw new Error(`invalid uuid: ${uuid}`);
  return Buffer.concat([Buffer.alloc(16), bytes]);
}

export function base58Decode(input: string): Buffer {
  let result = 0n;
  for (const char of input) {
    const value = BASE58_ALPHABET.indexOf(char);
    if (value === -1) throw new Error(`invalid base58 char: ${char}`);
    result = result * 58n + BigInt(value);
  }
  const body = Buffer.from(result.toString(16).padStart(2, "0"), "hex");
  const leadingZeros = input.match(/^1*/)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

export function base58Encode(input: Buffer): string {
  let n = 0n;
  for (const byte of input) n = n * 256n + BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  const leadingZeros = input.findIndex((b) => b !== 0);
  const zeroCount = leadingZeros === -1 ? input.length : leadingZeros;
  return "1".repeat(zeroCount) + out;
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

function legendre(a: bigint, p: bigint): bigint {
  return modPow(a, (p - 1n) / 2n, p);
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** True when the 32 bytes are NOT a valid compressed Ed25519 point (off the curve). */
function isOffCurve(compressed: Buffer): boolean {
  const bytes = Buffer.from(compressed); // little-endian
  const signBit = (bytes[31] & 0x80) !== 0;
  bytes[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);
  if (y >= P) return true;

  const y2 = (y * y) % P;
  const numerator = (y2 - 1n + P) % P;
  const denominator = (D * y2 + 1n) % P;
  if (denominator === 0n) return true; // x^2 undefined

  const x2 = (numerator * modInverse(denominator, P)) % P;

  // x^2 == 0: the point is (0, ±1) — valid only with a zero sign bit.
  if (x2 === 0n) return signBit;

  // Euler's criterion: x^2 is a quadratic residue → point decodes.
  if (legendre(x2, P) !== 1n) return true;

  const sqrtNeg1 = modPow(2n, (P - 1n) / 4n, P);
  let x = modPow(x2, (P + 3n) / 8n, P);
  if ((x * x) % P !== x2) x = (x * sqrtNeg1) % P; // try the other root
  if ((x * x) % P !== x2) return true;

  const expectedParity = signBit ? 1n : 0n;
  if ((x & 1n) !== expectedParity) {
    x = (P - x) % P;
    if ((x & 1n) !== expectedParity) return true;
  }
  return false;
}

/**
 * Canonical Solana findProgramAddress. Returns the off-curve address and the bump that
 * produced it, or null when no bump (255..0) yields an off-curve point (never in practice).
 */
export function findProgramAddress(seeds: Buffer[], programId: string): { address: Buffer; bump: number } | null {
  const programIdBytes = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    hash.update(Buffer.from([bump]));
    hash.update(programIdBytes);
    hash.update(PDA_MARKER);
    const address = hash.digest().subarray(0, 32);
    if (isOffCurve(address)) return { address, bump };
  }
  return null;
}

/** Derive the smart-account PDA address for a peridot_accounts.id (ADR 004 §5). */
export function deriveSmartAccountAddress(accountId: string, programId: string): SmartAccountAddress {
  const found = findProgramAddress([Buffer.from("peridot"), Buffer.from("account"), uuidTo32(accountId)], programId);
  if (!found) throw new Error("failed to derive an off-curve PDA address");
  return { address: base58Encode(found.address), bump: found.bump };
}