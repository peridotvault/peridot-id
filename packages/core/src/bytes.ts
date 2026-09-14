// Browser/Node-neutral byte helpers. No Buffer, no node:crypto — the SDK must run in
// browsers (Expo web), mobile, and Node alike.

export type Bytes = Uint8Array;

export function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * The 32-byte seed for a smart account: sha256(lowercased PID) (e.g. `ifal@pid`).
 * One identity owns exactly one personal wallet, so the permanent PID *is* the
 * seed — no surrogate account id. Lives here (not hash.ts) so web3-free
 * consumers (EVM derivation, API tests) never pull `@solana/web3.js`.
 * Sync (WebCrypto is async) via the pure-TS implementation below.
 */
export function pidToSeed32(pid: string): Uint8Array {
  const normalized = pid.trim().toLowerCase();
  if (normalized.length === 0) throw new Error("invalid pid");
  return sha256Sync(fromAscii(normalized));
}

/** Synchronous pure-TS SHA-256 (browser/Node-neutral). Cross-checked vs WebCrypto in bytes.spec. */
export function sha256Sync(data: Uint8Array): Uint8Array {
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
  new DataView(out.buffer).setUint32(0, h0);
  new DataView(out.buffer).setUint32(4, h1);
  new DataView(out.buffer).setUint32(8, h2);
  new DataView(out.buffer).setUint32(12, h3);
  new DataView(out.buffer).setUint32(16, h4);
  new DataView(out.buffer).setUint32(20, h5);
  new DataView(out.buffer).setUint32(24, h6);
  new DataView(out.buffer).setUint32(28, h7);
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, "");
  if (clean.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(data: Uint8Array): string {
  return Array.from(data).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromAscii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function asciiOf(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

/** RFC 4648 base64url, no padding. */
export function b64url(data: Uint8Array): string {
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function u64le(n: bigint | number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function i64le(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function u16le(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

/** Async SHA-256 via WebCrypto (available in browsers and Node ≥ 15). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

/** Convert a DER-encoded ECDSA signature (as returned by WebAuthn for ES256) to raw r‖s. */
export function derToRawEcdsa(der: Uint8Array): Uint8Array {
  // SEQUENCE { INTEGER r, INTEGER s }
  let i = 0;
  const tag = der[i++];
  if (tag !== 0x30) throw new Error("not a DER signature");
  const seqLen = der[i++];
  if (seqLen & 0x80) i += seqLen & 0x7f; // long form
  const ints: bigint[] = [];
  while (i < der.length) {
    const t = der[i++];
    if (t !== 0x02) throw new Error("not an INTEGER");
    let len = der[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | der[i++];
    }
    let v = 0n;
    for (let k = 0; k < len; k++) v = (v << 8n) | BigInt(der[i++]);
    ints.push(v);
  }
  if (ints.length !== 2) throw new Error("expected 2 integers");
  return concat(bigintToPadded32(ints[0]), bigintToPadded32(ints[1]));
}

function bigintToPadded32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** secp256r1 order — for low-S normalization. */
export const SECP256R1_ORDER = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

/** Normalize an ECDSA signature to low-S (the precompile enforces `s ≤ N/2`). */
export function normalizeLowS(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new Error("secp256r1 signature must be 64 bytes");
  const r = bytesToBigint(signature.subarray(0, 32));
  let s = bytesToBigint(signature.subarray(32));
  if (s > SECP256R1_ORDER / 2n) s = SECP256R1_ORDER - s;
  return concat(bigintToPadded32(r), bigintToPadded32(s));
}

function bytesToBigint(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}