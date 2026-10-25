// Destination-address validation for Send (ANT-346 M8). Dependency-free on
// purpose: no @solana/web3.js (web3.js layering rule) and no cross-feat
// imports (wallet AGENTS.md) — so this intentionally mirrors the base58/32
// check in feat/auth/utils/knownPrograms.ts rather than importing it.
// The server re-validates before signing; this gate stops typos/paste errors
// from ever reaching the withdraw call.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode base58 to bytes; throws on invalid characters. */
function base58ToBytes(s: string): Uint8Array {
  if (s.length === 0) throw new Error("empty address");
  for (const ch of s) {
    if (!BASE58_ALPHABET.includes(ch)) throw new Error("invalid base58 character");
  }
  const bytes: number[] = [0];
  for (const ch of s) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const be = new Uint8Array(bytes.reverse());
  let firstNonZero = 0;
  while (firstNonZero < be.length && be[firstNonZero] === 0) firstNonZero++;
  const significant = be.subarray(firstNonZero);
  const out = new Uint8Array(leadingZeros + significant.length);
  out.set(significant, leadingZeros);
  return out;
}

/** True when the value is a well-formed Solana address: base58, 32 bytes. */
export function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return false;
  try {
    return base58ToBytes(trimmed).length === 32;
  } catch {
    return false;
  }
}

/** User-facing destination error for Send, or null when sendable. */
export function sendDestinationError(to: string): string | null {
  if (!to.trim()) return "Enter a destination address.";
  if (!isSolanaAddress(to)) {
    return "That doesn't look like a Solana address (base58, 32 bytes). Check it and try again.";
  }
  return null;
}
