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