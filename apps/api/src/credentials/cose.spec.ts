import { coseToCompressedBase64url, coseToCompressedSecp256r1 } from "./cose";

// Build a COSE_Key (ES256) CBOR from x/y coordinates.
function buildCoseKey(x: Buffer, y: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from([0xa4]), // map(4)
    Buffer.from([0x01, 0x02]), // kty = EC2
    Buffer.from([0x03, 0x26]), // alg = -7 (ES256)
    Buffer.from([0x20, 0x01]), // crv = P-256
    Buffer.from([0x21, 0x58, 0x20]), x, // x (32 bytes)
    Buffer.from([0x22, 0x58, 0x20]), y, // y (32 bytes)
  ]);
}

describe("coseToCompressedSecp256r1", () => {
  it("encodes even-y as 0x02 prefix", () => {
    const x = Buffer.alloc(32, 0x11);
    const y = Buffer.alloc(32, 0x22); // y[31] = 0x22 (even)
    const out = coseToCompressedSecp256r1(buildCoseKey(x, y));
    expect(out.length).toBe(33);
    expect(out[0]).toBe(0x02);
    expect(out.subarray(1)).toEqual(x);
  });

  it("encodes odd-y as 0x03 prefix", () => {
    const x = Buffer.alloc(32, 0x11);
    const y = Buffer.alloc(32, 0x22);
    y[31] = 0x23; // odd
    const out = coseToCompressedSecp256r1(buildCoseKey(x, y));
    expect(out[0]).toBe(0x03);
  });

  it("round-trips through base64url", () => {
    const x = Buffer.alloc(32, 0x11);
    const y = Buffer.alloc(32, 0x22);
    const b64 = coseToCompressedBase64url(buildCoseKey(x, y));
    expect(Buffer.from(b64, "base64url").length).toBe(33);
  });

  it("rejects a non-EC2 / malformed key", () => {
    expect(() => coseToCompressedSecp256r1(Buffer.from([0xa1, 0x01, 0x02]))).toThrow();
  });
});