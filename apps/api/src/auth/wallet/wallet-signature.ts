// External-wallet proof of ownership (stage 2 of docs/plan/02-external-wallet-auth).
//
// Pure functions: address normalization + signature verification, no Nest, no
// DB. A signature is proof of CONTROL of an address — never identity
// verification, never a transfer, never authority over a PeridotID smart
// account. Callers bind the message (address, chain, nonce, action) before
// trusting a `true`.
//
// Base58 is implemented here (Bitcoin alphabet) instead of pulling web3.js:
// this file must stay importable from plain Node/jest without the Solana
// client's ESM surface.
import { createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { verifyMessage } from "viem";

/** Chain namespaces an external wallet login can prove. */
export type WalletNamespace = "solana" | "evm";

export const WALLET_NAMESPACES: readonly WalletNamespace[] = ["solana", "evm"];

/**
 * DER SPKI header for a raw 32-byte Ed25519 public key. Node's crypto verifies
 * Ed25519 with the stdlib alone — no extra curve dependency.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58_ALPHABET].map((char, i) => [char, i]));

/** Base58 (Bitcoin alphabet) encode — used for Solana address round-trips. */
export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = B58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

/** Base58 decode; null on any character outside the alphabet. */
function decodeBase58(input: string): Buffer | null {
  let value = 0n;
  for (const char of input) {
    const digit = B58_INDEX.get(char);
    if (digit === undefined) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of input) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/**
 * Canonical form of an address for credential lookup, or null when it is not a
 * valid address for that chain.
 * - EVM: lowercase hex (case carries no meaning; checksum is display only).
 * - Solana: the base58 string EXACTLY as given — base58 is case-sensitive, so
 *   lowercasing a Solana address would point at a different account.
 */
export function normalizeWalletAddress(namespace: WalletNamespace, address: string): string | null {
  const raw = address.trim();
  if (!raw) return null;
  if (namespace === "evm") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
    return raw.toLowerCase();
  }
  const bytes = decodeBase58(raw);
  // A valid Solana address is exactly 32 bytes and canonical base58 (decode →
  // encode round-trips), which rejects padding tricks and truncated keys.
  if (!bytes || bytes.length !== 32 || encodeBase58(bytes) !== raw) return null;
  return raw;
}

/**
 * Verify `signature` over the UTF-8 bytes of `message` by `address`.
 * Signature encoding is per chain: base64 for Solana wallets, hex for EVM.
 * Never throws — a malformed address or signature is simply not a proof.
 */
export async function verifyWalletSignature(input: {
  namespace: WalletNamespace;
  address: string;
  message: string;
  signature: string;
}): Promise<boolean> {
  const address = normalizeWalletAddress(input.namespace, input.address);
  if (!address) return false;
  if (input.namespace === "solana") return verifySolana({ ...input, address });
  try {
    return await verifyMessage({
      address: address as `0x${string}`,
      message: input.message,
      signature: input.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

function verifySolana(input: { address: string; message: string; signature: string }): boolean {
  try {
    const raw = decodeBase58(input.address);
    if (!raw || raw.length !== 32) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return verifyEd25519(null, Buffer.from(input.message, "utf8"), publicKey, Buffer.from(input.signature, "base64"));
  } catch {
    return false;
  }
}
