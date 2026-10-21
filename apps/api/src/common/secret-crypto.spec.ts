// ANT-286a: envelope-encryption regression tests. Fail on plaintext-at-rest.
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secret-crypto";

const KEY = "ab".repeat(32); // 32-byte hex fixture

describe("secret-crypto (ANT-286a)", () => {
  it("encrypts to a versioned envelope, decrypts back", () => {
    const enc = encryptSecret("pidwh_abc123", KEY);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(enc).not.toContain("pidwh_abc123");
    expect(decryptSecret(enc, KEY)).toBe("pidwh_abc123");
    expect(isEncryptedSecret(enc)).toBe(true);
  });

  it("legacy plaintext passes through (migration path)", () => {
    expect(decryptSecret("0x" + "11".repeat(32), KEY)).toBe("0x" + "11".repeat(32));
    expect(isEncryptedSecret("0x" + "11".repeat(32))).toBe(false);
  });

  it("fail-closed: encrypt without key throws; decrypt of envelope without key throws", () => {
    expect(() => encryptSecret("x", "")).toThrow();
    const enc = encryptSecret("x", KEY);
    expect(() => decryptSecret(enc, "")).toThrow();
  });

  it("tampered envelope fails closed", () => {
    const enc = encryptSecret("secret", KEY);
    const tampered = enc.slice(0, -1) + (enc.endsWith("0") ? "1" : "0");
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });
});
