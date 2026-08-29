// Minimal COSE_Key (ES256 / P-256) → 33-byte compressed secp256r1 public key.
//
// The stored `authorities.public_key` is the COSE-encoded CBOR key simplewebauthn needs
// for verification. The on-chain smart account authority (task 004) is the 33-byte
// compressed point `[parity] || x`. This parses just the fields we need from the COSE key.

const P256_CRV = 1; // COSE "crv" = P-256
const KEY_X = -2; // COSE key for x-coordinate
const KEY_Y = -3; // COSE key for y-coordinate

class CoseError extends Error {}

/** CBOR reader limited to the structures present in a COSE EC2 public key. */
class Cbor {
  offset = 0;
  constructor(private readonly buf: Buffer) {}

  private readByte(): number {
    if (this.offset >= this.buf.length) throw new CoseError("cbor: truncated");
    return this.buf[this.offset++];
  }

  private readLength(initial: number): number {
    if (initial < 24) return initial;
    if (initial === 24) return this.readByte();
    if (initial === 25) {
      const v = this.buf.readUInt16BE(this.offset);
      this.offset += 2;
      return v;
    }
    if (initial === 26) {
      const v = this.buf.readUInt32BE(this.offset);
      this.offset += 4;
      return v;
    }
    throw new CoseError("cbor: length too large");
  }

  /** Returns a positive integer header value (major type 0/1/2/5). */
  readHeader(): { major: number; value: number } {
    const b = this.readByte();
    return { major: b >> 5, value: this.readLength(b & 0x1f) };
  }

  readInt(): number {
    const { major, value } = this.readHeader();
    if (major === 0) return value;
    if (major === 1) return -1 - value;
    throw new CoseError("cbor: expected int");
  }

  readBytes(): Buffer {
    const { major, value } = this.readHeader();
    if (major !== 2) throw new CoseError("cbor: expected byte string");
    const out = this.buf.subarray(this.offset, this.offset + value);
    this.offset += value;
    if (out.length !== value) throw new CoseError("cbor: truncated byte string");
    return Buffer.from(out);
  }

  readMapLength(): number {
    const { major, value } = this.readHeader();
    if (major !== 5) throw new CoseError("cbor: expected map");
    return value;
  }
}

/**
 * Convert a COSE EC2 (ES256) public key to the 33-byte compressed secp256r1 form
 * `[0x02 | (y&1)] || x`. Throws on malformed input.
 */
export function coseToCompressedSecp256r1(cose: Buffer): Buffer {
  const c = new Cbor(cose);
  const pairs = c.readMapLength();
  let x: Buffer | null = null;
  let y: Buffer | null = null;
  for (let i = 0; i < pairs; i++) {
    const key = c.readInt();
    if (key === -1) {
      if (c.readInt() !== P256_CRV) throw new CoseError("cose: not P-256");
    } else if (key === KEY_X) {
      x = c.readBytes();
    } else if (key === KEY_Y) {
      y = c.readBytes();
    } else {
      // Skip unknown value (int, bytes, or short text/array). Values here are small.
      const { major, value } = c.readHeader();
      c.offset += value;
    }
  }
  if (!x || !y || x.length !== 32 || y.length !== 32) {
    throw new CoseError("cose: missing x/y");
  }
  const parity = (y[31] & 1) === 1 ? 0x03 : 0x02;
  return Buffer.concat([Buffer.from([parity]), x]);
}

export function coseToCompressedBase64url(cose: Buffer): string {
  return coseToCompressedSecp256r1(cose).toString("base64url");
}