// Unknown-target execute disclosure gate (ANT-261 spec, ANT-262 implementation).
//
// Pure client-side helpers: no network, no logging of raw call-data.
// Single-feat owner: feat/auth (screens may import any feat per wallet AGENTS.md).
// Dependency-free (no @solana/web3.js, no pid-core runtime): base58 validation,
// base64 decoding, and SHA-256 are implemented locally so the wallet bundle and
// the web3.js layering rule stay untouched.
//
// Open questions from ANT-261 (both unconfirmed at implementation time):
// - O1 (Memo v1 in known set): UNCONFIRMED — Memo is EXCLUDED here (fail-closed
//   direction: a Memo call will disclose rather than silently sign).
// - O2 (known target + hostile data): accepted residual per spec recommendation —
//   a known target never discloses, regardless of data/metas.

/** Static known-good execute targets (exact IDs per ANT-261 FR3). */
export const KNOWN_EXECUTE_PROGRAMS: ReadonlySet<string> = new Set([
  "11111111111111111111111111111111", // System
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdk8jVTQdZaVx5ZMokU82UYnL4p", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5XWH25efTNsLJA8knL", // Associated Token
  "ComputeBudget111111111111111111111111111111", // Compute Budget
  // NOTE (O1): Memo v1 `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`
  // deliberately excluded until the CTO confirms it.
]);

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode base58 to bytes; throws on invalid characters. */
function base58ToBytes(s: string): Uint8Array {
  if (s.length === 0) throw new Error("empty address");
  for (const ch of s) {
    if (!BASE58_ALPHABET.includes(ch)) throw new Error("invalid base58 character");
  }
  // Convert base58 string to byte array (big-endian base conversion).
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
  // Count leading '1's (zero bytes).
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const be = new Uint8Array(bytes.reverse());
  // Strip leading zero bytes produced by the conversion, then re-add.
  let firstNonZero = 0;
  while (firstNonZero < be.length && be[firstNonZero] === 0) firstNonZero++;
  const significant = be.subarray(firstNonZero);
  const out = new Uint8Array(leadingZeros + significant.length);
  out.set(significant, leadingZeros);
  return out;
}

/** Well-formed Solana program address: valid base58 decoding to exactly 32 bytes. */
export function isWellFormedExecuteTarget(target: unknown): target is string {
  if (typeof target !== "string" || target.length < 32 || target.length > 44) return false;
  try {
    return base58ToBytes(target).length === 32;
  } catch {
    return false;
  }
}

/**
 * True when the target is in the known-good set.
 * Fail-closed: malformed input, a missing/unparseable set, or any error
 * returns false (unknown) — never fail open to silent signing.
 */
export function isKnownExecuteTarget(target: unknown): boolean {
  try {
    if (typeof target !== "string") return false;
    if (!KNOWN_EXECUTE_PROGRAMS || KNOWN_EXECUTE_PROGRAMS.size === 0) return false;
    return (KNOWN_EXECUTE_PROGRAMS as ReadonlySet<string>).has(target);
  } catch {
    return false;
  }
}

export type ExecuteMeta = { address: string; writable: boolean; signer: boolean };

export type ExecuteCallInput = {
  target: unknown;
  metas: unknown;
  data: unknown;
};

export type ExecuteCallDescription = {
  target: string;
  dataLen: number;
  dataHashHex: string;
  metaCount: number;
  writableCount: number;
};

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode base64/base64url (padded or not) to bytes; throws on bad input. */
function base64ToBytes(s: string): Uint8Array {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  if (std.length % 4 === 1) throw new Error("invalid data encoding");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(std)) throw new Error("invalid data encoding");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of std) {
    if (ch === "=") break;
    buffer = (buffer << 6) | B64_CHARS.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Decode execute call-data (base64url, no padding — tolerates standard base64). Never throws raw bytes. */
function decodeExecuteData(data: unknown): Uint8Array {
  if (typeof data !== "string") throw new Error("invalid data: not a string");
  if (data === "") return new Uint8Array(0);
  if (data.length > 2 * 1024 * 1024) throw new Error("data too large");
  return base64ToBytes(data);
}

/** Synchronous pure-TS SHA-256 (browser/Node-neutral; no WebCrypto needed). */
function sha256Sync(data: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bitLen = data.length * 8;
  const paddedLen = (((data.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 2 ** 32));
  const w = new Array<number>(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  outView.setUint32(20, h5);
  outView.setUint32(24, h6);
  outView.setUint32(28, h7);
  return out;
}

function toHex(data: Uint8Array): string {
  return Array.from(data).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalizeMetas(metas: unknown): ExecuteMeta[] {
  if (!Array.isArray(metas)) throw new Error("invalid metas: not an array");
  return metas.map((m) => {
    const r = (m ?? {}) as Record<string, unknown>;
    if (typeof r.address !== "string" || !isWellFormedExecuteTarget(r.address)) {
      throw new Error("invalid meta address");
    }
    return { address: r.address, writable: r.writable === true, signer: r.signer === true };
  });
}

/**
 * Describe an execute call for disclosure: byte length + sha256 hex of the raw
 * data (computed locally), account counts. Never includes raw call-data bytes
 * in its output — only length and hash.
 */
export function describeExecuteCall(input: ExecuteCallInput): ExecuteCallDescription {
  if (!isWellFormedExecuteTarget(input.target)) throw new Error("invalid execute target");
  const raw = decodeExecuteData(input.data);
  const metas = normalizeMetas(input.metas);
  return {
    target: input.target,
    dataLen: raw.length,
    dataHashHex: toHex(sha256Sync(raw)),
    metaCount: metas.length,
    writableCount: metas.filter((m) => m.writable).length,
  };
}

export type ExecuteGate =
  | { kind: "not-execute" }
  | { kind: "known" }
  | { kind: "unknown"; description: ExecuteCallDescription }
  | { kind: "invalid"; reason: string };

/** Classify an action/payload for the execute gate (pure, no network). */
export function getExecuteGate(action: string, payload: unknown): ExecuteGate {
  if (action !== "execute") return { kind: "not-execute" };
  const p = (payload ?? {}) as Record<string, unknown>;
  if (!isWellFormedExecuteTarget(p.target)) {
    return { kind: "invalid", reason: "The program address in this request is malformed. Deny it — the transaction would fail." };
  }
  if (isKnownExecuteTarget(p.target)) return { kind: "known" };
  try {
    const description = describeExecuteCall({ target: p.target, metas: p.metas, data: p.data });
    return { kind: "unknown", description };
  } catch {
    return { kind: "invalid", reason: "This execute request is malformed and cannot be described. Deny it." };
  }
}

/**
 * Enforcement helper for every `peridot.wallet.execute` call site (popup and
 * first-party). Throws when approval must not proceed: unknown targets require
 * explicit acknowledgement, malformed requests are always blocked.
 * Call BEFORE any passkey ceremony or `/v1/wallet/execute` call.
 */
export function assertExecuteGateAllows(
  action: string,
  payload: unknown,
  opts?: { unknownAcknowledged?: boolean },
): void {
  const gate = getExecuteGate(action, payload);
  if (gate.kind === "not-execute" || gate.kind === "known") return;
  if (gate.kind === "invalid") throw new Error(gate.reason);
  if (opts?.unknownAcknowledged !== true) {
    throw new Error("Unknown program: explicit acknowledgement is required before signing.");
  }
}
