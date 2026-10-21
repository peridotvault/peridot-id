// Secret-at-rest envelope encryption (ANT-286a).
//
// Threat: PidApp.webhookSecret + EvmRelayerKey.secret were stored plaintext —
// a read-only DB leak (backup, replica, SQLi) yields live HMAC-signing and
// EVM-relayer keys directly (STRIDE: Information disclosure → Tampering/
// Elevation of privilege).
//
// Mechanism: AES-256-GCM with a server-side data key from env
// `PID_SECRETS_ENC_KEY` (32-byte hex, 64 chars). Ciphertext lands in the SAME
// TEXT column as `enc:v1:<ivHex>:<ctHex>` so no schema migration is needed;
// legacy plaintext rows keep reading (decrypt falls back) and are upgraded
// lazily on next write (rotation / webhook re-set / relayer re-set).
//
// Fail-secure: encrypt throws when the key is missing/malformed (fail closed
// on write); decrypt of an `enc:v1:` row without a usable key throws (fail
// closed on read — never silently fall back to treating ciphertext as a key).
// Plaintext fallback applies ONLY to rows that were never encrypted.
// Key rotation = set new key, re-set secrets (each set re-encrypts).

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";

function keyBytes(keyHex?: string): Buffer {
  const raw = (keyHex ?? process.env.PID_SECRETS_ENC_KEY ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("PID_SECRETS_ENC_KEY must be 32-byte hex (64 chars)");
  }
  return Buffer.from(raw, "hex");
}

/** Encrypt a plaintext secret for storage. Throws when no usable key. */
export function encryptSecret(plaintext: string, keyHex?: string): string {
  if (!plaintext) throw new Error("encryptSecret: empty plaintext refused");
  const key = keyBytes(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${Buffer.concat([tag, ct]).toString("hex")}`;
}

/**
 * Decrypt a stored value. `enc:v1:` rows require the key (throws without it —
 * fail closed). Legacy plaintext passes through unchanged for migration.
 */
export function decryptSecret(stored: string | null | undefined, keyHex?: string): string | null {
  if (stored == null || stored === "") return null;
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext — upgrade on next write
  const key = keyBytes(keyHex);
  const rest = stored.slice(PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep < 0) throw new Error("decryptSecret: malformed envelope");
  const iv = Buffer.from(rest.slice(0, sep), "hex");
  const blob = Buffer.from(rest.slice(sep + 1), "hex");
  if (iv.length !== 12 || blob.length < 17) throw new Error("decryptSecret: malformed envelope");
  const tag = blob.subarray(0, 16);
  const ct = blob.subarray(16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** True when the stored value is envelope-encrypted (vs legacy plaintext). */
export function isEncryptedSecret(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(PREFIX);
}
