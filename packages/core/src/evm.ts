// EVM counterfactual helpers — CREATE2 address derivation + payload binding.
//
// Mirrors `hash.ts` (Solana PDA) for `eip155` chains: the smart-account address is a
// pure function of the pidAccount.id (as the CREATE2 salt), NOT of Google or the
// passkey. The passkey (x,y) is stored later on `initialize`, so rotation never
// changes the address — same split as Solana (PDA vs authority).
// Browser-safe: @noble/hashes only, no Buffer, no node:crypto.

import { keccak_256 } from "@noble/hashes/sha3";
import { accountIdToSeed32, concat, fromAscii, fromHex, toHex } from "./bytes";
import type { Bytes } from "./bytes";

// Re-exported byte vocabulary so EVM consumers never touch the web3.js index.
export { concat, fromAscii, fromHex, toHex };
export type { Bytes };

/** Domain separator for the EVM signed authorization payload (mirrors DOMAIN). */
export const DOMAIN_EVM = fromAscii("PID|EVM|SMART_ACCOUNT|v1");

export interface EvmChain {
  namespace: "eip155";
  /** CAIP-2 reference = decimal chain id string. */
  chainReference: string;
  chainId: number;
  name: string;
  nativeSymbol: string;
}

// ponytail: testnets first; mainnets (143 monad / 56 bsc / 42161 arbitrum-one)
// deploy with the same factory or the same-address guarantee breaks.
/** Phase-1 chains: one deterministic address across all three (same factory). */
export const EVM_CHAINS: EvmChain[] = [
  { namespace: "eip155", chainReference: "10143", chainId: 10143, name: "monad-testnet", nativeSymbol: "MON" },
  { namespace: "eip155", chainReference: "97", chainId: 97, name: "bsc-testnet", nativeSymbol: "tBNB" },
  { namespace: "eip155", chainReference: "421614", chainId: 421614, name: "arbitrum-sepolia", nativeSymbol: "ETH" },
  { namespace: "eip155", chainReference: "84532", chainId: 84532, name: "base-sepolia", nativeSymbol: "ETH" },
];

export function keccak256(data: Uint8Array): Uint8Array {
  return keccak_256(data);
}

/** CREATE2 salt for an account: the same zero-padded UUID seed Solana uses. */
export function accountIdToSalt32(accountId: string): Uint8Array {
  return accountIdToSeed32(accountId);
}

/** Raw 20 address bytes from a `0x…`/bare hex string. Throws on bad input. */
export function addressToBytes(address: string): Uint8Array {
  const clean = address.startsWith("0x") ? address.slice(2) : address;
  if (!/^[0-9a-fA-F]{40}$/.test(clean)) throw new Error(`invalid evm address: ${address}`);
  return fromHex(clean.toLowerCase());
}

/** EIP-55 checksummed `0x…` address. */
export function toChecksumAddress(address: string): string {
  const lower = (address.startsWith("0x") ? address.slice(2) : address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`invalid evm address: ${address}`);
  const hash = toHex(keccak256(fromAscii(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/**
 * EIP-1167 minimal-proxy creation code for `implementation`.
 * 45 bytes: prefix ++ implementation ++ suffix.
 */
export function minimalProxyInitCode(implementation: string): Uint8Array {
  return concat(fromHex("3d602d80600a3d3981f3363d3d373d3d3d363d73"), addressToBytes(implementation), fromHex("5af43d82803e903d91602b57fd5bf3"));
}

/**
 * Canonical CREATE2 address: `keccak256(0xff ‖ factory ‖ salt ‖ initCodeHash)[12:]`.
 * `salt` must be 32 bytes, `initCodeHash` 32 bytes.
 */
export function getCreate2Address(factory: string, salt32: Uint8Array, initCodeHash: Uint8Array): string {
  if (salt32.length !== 32) throw new Error("create2 salt must be 32 bytes");
  if (initCodeHash.length !== 32) throw new Error("init code hash must be 32 bytes");
  const preimage = concat(new Uint8Array([0xff]), addressToBytes(factory), salt32, initCodeHash);
  return toChecksumAddress("0x" + toHex(keccak256(preimage).subarray(12)));
}

/**
 * Derive the counterfactual smart-account address: salt from the account id,
 * init code from the shared implementation. Same `(factory, implementation)`
 * on every chain → same address on every chain.
 */
export function deriveEvmSmartAccountAddress(
  accountId: string,
  factory: string,
  implementation: string,
): { address: string; salt: string } {
  const salt = accountIdToSalt32(accountId);
  const initCodeHash = keccak256(minimalProxyInitCode(implementation));
  return { address: getCreate2Address(factory, salt, initCodeHash), salt: "0x" + toHex(salt) };
}

/** Domain-separated EVM authorization payload: `keccak256(DOMAIN_EVM ‖ parts…)`. */
export function buildEvmAuthorizationPayload(parts: Uint8Array[]): Uint8Array {
  return keccak256(concat(DOMAIN_EVM, ...parts));
}

/**
 * Split a 64-byte raw x‖y key into coordinates. EVM `initialize(x, y)` needs the
 * full y — the server rebuilds x‖y from the stored COSE credential (which keeps
 * both coordinates), NOT from the 33-byte Solana compressed form (parity only).
 */
export function splitRawXy(raw: Uint8Array): { x: Uint8Array; y: Uint8Array } {
  if (raw.length !== 64) throw new Error("expected 64-byte raw x||y key");
  return { x: raw.subarray(0, 32), y: raw.subarray(32) };
}

/** The 32-byte x coordinate (+ parity bit) from a 33-byte compressed key. */
export function compressedToX(compressed: Uint8Array): { x: Uint8Array; parity: number } {
  if (compressed.length !== 33 || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) {
    throw new Error("expected 33-byte compressed secp256r1 key");
  }
  return { x: compressed.subarray(1), parity: compressed[0] & 1 };
}
