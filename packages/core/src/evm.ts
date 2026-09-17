// EVM counterfactual helpers — CREATE2 address derivation + payload binding.
//
// Mirrors `hash.ts` (Solana PDA) for `eip155` chains: the smart-account address is a
// pure function of the pid (as the CREATE2 salt), NOT of Google or the
// passkey. The passkey (x,y) is stored later on `initialize`, so rotation never
// changes the address — same split as Solana (PDA vs authority).
// Browser-safe: @noble/hashes only, no Buffer, no node:crypto.

import { keccak_256 } from "@noble/hashes/sha3";
import { concat, fromAscii, fromHex, pidToSeed32, toHex } from "./bytes";
import type { Bytes } from "./bytes";

// Re-exported byte vocabulary so EVM consumers never touch the web3.js index.
export { concat, fromAscii, fromHex, toHex };
export type { Bytes };

/** Domain separator for the EVM signed authorization payload (mirrors DOMAIN). */
export const DOMAIN_EVM = fromAscii("PID|EVM|SMART_ACCOUNT|v1");
/** V2 domain (frozen). V1 payloads can never verify as V2. */
export const DOMAIN_EVM_V2 = fromAscii("PID|EVM|SMART_ACCOUNT|v2");
/** V3 domain (canonical). V2 payloads can never verify as V3. */
export const DOMAIN_EVM_V3 = fromAscii("PID|EVM|SMART_ACCOUNT|v3");

/** V2 operation tags — first payload byte after the domain. */
export const OP_EVM = {
  execute: 0x01,
  updateAuthority: 0x03,
  activate: 0x05,
} as const;

/** V4 permission domain (canonical). Disjoint from all SMART_ACCOUNT domains. */
export const DOMAIN_EVM_PERM = fromAscii("PID|EVM|PERMISSION|v1");

/** V4 permission operation tags — first payload byte after the permission domain. */
export const OP_PERM = {
  grant: 0x10,
  revoke: 0x11,
  permExec: 0x12,
  install: 0x13,
  uninstall: 0x14,
  exec7579: 0x15,
  sign1271: 0x16,
} as const;

/** V4 permission kinds (match the contract's KIND_* constants). */
export const PERM_KIND = {
  nonfinancial: 1,
  eth: 2,
  erc20: 3,
  erc721: 4,
  erc1155: 5,
} as const;

/** ERC-7579 module type ids. */
export const MODULE_TYPE = { validator: 1, executor: 2, fallback: 3, hook: 4 } as const;

/** Selectors a NONFINANCIAL permission may never invoke (mirror of `_deniedSelector`). */
export const DENIED_SELECTORS = [
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x095ea7b3", // approve(address,uint256)
  "0x39509351", // increaseAllowance(address,uint256)
  "0xa457c2d7", // decreaseAllowance(address,uint256)
  "0xd505accf", // permit(...)
  "0x42842e0e", // safeTransferFrom(address,address,uint256)
  "0xb88d4fde", // safeTransferFrom(address,address,uint256,bytes)
  "0xf242432a", // safeTransferFrom(address,address,uint256,uint256,bytes)
  "0x2eb2c2d6", // safeBatchTransferFrom(...)
  "0xa22cb465", // setApprovalForAll(address,bool)
  "0x87517c45", // Permit2 approve(...)
  "0x2a2e0c7a", // Permit2 permit(...)
] as const;

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

/** CREATE2 salt for a pid: the same sha256(pid) seed Solana uses. */
export function pidToSalt32(pid: string): Uint8Array {
  return pidToSeed32(pid);
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
 * Creation code: 20B prefix ++ implementation (20B) ++ 15B suffix (55B total,
 * deploying the 45B runtime proxy).
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
 * Derive the counterfactual smart-account address: salt from the pid,
 * init code from the shared implementation. Same `(factory, implementation)`
 * on every chain → same address on every chain.
 */
export function deriveEvmSmartAccountAddress(
  pid: string,
  factory: string,
  implementation: string,
): { address: string; salt: string } {
  const salt = pidToSalt32(pid);
  const initCodeHash = keccak256(minimalProxyInitCode(implementation));
  return { address: getCreate2Address(factory, salt, initCodeHash), salt: "0x" + toHex(salt) };
}

/** Domain-separated EVM authorization payload: `keccak256(DOMAIN_EVM ‖ parts…)`. */
export function buildEvmAuthorizationPayload(parts: Uint8Array[]): Uint8Array {
  return keccak256(concat(DOMAIN_EVM, ...parts));
}

/** V2 payload hash: `keccak256(DOMAIN_EVM_V2 ‖ opTag ‖ parts…)` (frozen). */
export function buildEvmAuthorizationPayloadV2(opTag: number, parts: Uint8Array[]): Uint8Array {
  return keccak256(concat(DOMAIN_EVM_V2, new Uint8Array([opTag & 0xff]), ...parts));
}

/** V3 payload hash: `keccak256(DOMAIN_EVM_V3 ‖ opTag ‖ parts…)` (canonical). */
export function buildEvmAuthorizationPayloadV3(opTag: number, parts: Uint8Array[]): Uint8Array {
  return keccak256(concat(DOMAIN_EVM_V3, new Uint8Array([opTag & 0xff]), ...parts));
}

/** Big-endian fixed-width integer (matches `abi.encodePacked` uint encoding). */
export function beUint(value: bigint | number, bytes: number): Uint8Array {
  let v = BigInt(value);
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("evm abi value overflows width");
  return out;
}

/** V4 permission payload hash: `keccak256(DOMAIN_EVM_PERM ‖ opTag ‖ parts…)`. */
export function buildEvmPermissionPayload(opTag: number, parts: Uint8Array[]): Uint8Array {
  return keccak256(concat(DOMAIN_EVM_PERM, new Uint8Array([opTag & 0xff]), ...parts));
}

export interface PermissionScope {
  sessionX: Uint8Array;
  sessionY: Uint8Array;
  kind: number;
  target: string;
  selector: Uint8Array; // 4 bytes
  token: string;
  to: string;
  nftId: bigint | number;
  validUntil: bigint | number;
  salt: Uint8Array; // 32 bytes
}

function addrBytes(address: string): Uint8Array {
  return addressToBytes(address);
}

/** Canonical permission id (field-for-field match of `_permissionId`). */
export function buildPermissionId(chainId: bigint | number, account: string, scope: PermissionScope): Uint8Array {
  if (scope.sessionX.length !== 32 || scope.sessionY.length !== 32) throw new Error("session key must be 32+32 bytes");
  if (scope.selector.length !== 4) throw new Error("selector must be 4 bytes");
  if (scope.salt.length !== 32) throw new Error("salt must be 32 bytes");
  return keccak256(
    concat(
      DOMAIN_EVM_PERM,
      beUint(chainId, 32),
      addrBytes(account),
      scope.sessionX,
      scope.sessionY,
      new Uint8Array([scope.kind & 0xff]),
      addrBytes(scope.target),
      scope.selector,
      addrBytes(scope.token),
      addrBytes(scope.to),
      beUint(scope.nftId, 32),
      beUint(scope.validUntil, 8),
      scope.salt,
    ),
  );
}

/** Owner-signed grant payload (what the passkey signs as the WebAuthn challenge). */
export function buildGrantPayload(args: {
  chainId: bigint | number;
  account: string;
  permissionId: Uint8Array;
  scope: PermissionScope;
  perTxCap: bigint | number;
  totalLimit: bigint | number;
  validAfter: bigint | number;
  nonce: bigint | number;
  deadline: bigint | number;
}): Uint8Array {
  return buildEvmPermissionPayload(OP_PERM.grant, [
    beUint(args.chainId, 32),
    addrBytes(args.account),
    args.permissionId,
    args.scope.sessionX,
    args.scope.sessionY,
    new Uint8Array([args.scope.kind & 0xff]),
    addrBytes(args.scope.target),
    args.scope.selector,
    addrBytes(args.scope.token),
    addrBytes(args.scope.to),
    beUint(args.perTxCap, 32),
    beUint(args.totalLimit, 32),
    beUint(args.scope.nftId, 32),
    beUint(args.validAfter, 8),
    beUint(args.scope.validUntil, 8),
    beUint(args.nonce, 8),
    beUint(args.deadline, 8),
  ]);
}

/** Owner-signed revocation payload. */
export function buildRevokePayload(args: {
  chainId: bigint | number;
  account: string;
  permissionId: Uint8Array;
  nonce: bigint | number;
  deadline: bigint | number;
}): Uint8Array {
  return buildEvmPermissionPayload(OP_PERM.revoke, [
    beUint(args.chainId, 32),
    addrBytes(args.account),
    args.permissionId,
    beUint(args.nonce, 8),
    beUint(args.deadline, 8),
  ]);
}

/** Session-signed permission-execution payload. */
export function buildPermExecPayload(args: {
  chainId: bigint | number;
  account: string;
  permissionId: Uint8Array;
  seq: bigint | number;
  target: string;
  value: bigint | number;
  dataHash: Uint8Array;
  deadline: bigint | number;
  feePolicyVersion: number;
}): Uint8Array {
  return buildEvmPermissionPayload(OP_PERM.permExec, [
    beUint(args.chainId, 32),
    addrBytes(args.account),
    args.permissionId,
    beUint(args.seq, 8),
    addrBytes(args.target),
    beUint(args.value, 32),
    args.dataHash,
    beUint(args.deadline, 8),
    beUint(args.feePolicyVersion, 2),
  ]);
}

/** Owner-signed ERC-7579 `execute` payload (auth travels inside `executionCalldata`). */
export function buildExec7579Payload(args: {
  chainId: bigint | number;
  account: string;
  nonce: bigint | number;
  target: string;
  value: bigint | number;
  dataHash: Uint8Array;
  deadline: bigint | number;
  feePolicyVersion: number;
}): Uint8Array {
  return buildEvmPermissionPayload(OP_PERM.exec7579, [
    beUint(args.chainId, 32),
    addrBytes(args.account),
    beUint(args.nonce, 8),
    addrBytes(args.target),
    beUint(args.value, 32),
    args.dataHash,
    beUint(args.deadline, 8),
    beUint(args.feePolicyVersion, 2),
  ]);
}

/** Owner-signed module install/uninstall payload. */
export function buildModulePayload(args: {
  opTag: number; // OP_PERM.install | OP_PERM.uninstall
  chainId: bigint | number;
  account: string;
  moduleTypeId: bigint | number;
  module: string;
  initDataHash: Uint8Array;
  nonce: bigint | number;
  deadline: bigint | number;
}): Uint8Array {
  return buildEvmPermissionPayload(args.opTag, [
    beUint(args.chainId, 32),
    addrBytes(args.account),
    beUint(args.moduleTypeId, 32),
    addrBytes(args.module),
    args.initDataHash,
    beUint(args.nonce, 8),
    beUint(args.deadline, 8),
  ]);
}

/** ERC-1271 expected challenge (defensive rehash: account + chain bound). */
export function build1271Challenge(args: { chainId: bigint | number; account: string; hash: Uint8Array }): Uint8Array {
  return keccak256(
    concat(
      DOMAIN_EVM_V3,
      new Uint8Array([OP_PERM.sign1271 & 0xff]),
      beUint(args.chainId, 32),
      addrBytes(args.account),
      args.hash,
    ),
  );
}

/** 20-byte address left-padded to 32 (ABI address encoding). */
export function paddedAddress(address: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(addrBytes(address), 12);
  return out;
}

/** Canonical ERC-20 `transfer(to, amount)` calldata. */
export function buildErc20Transfer(to: string, amount: bigint | number): Uint8Array {
  return concat(fromHex("a9059cbb"), paddedAddress(to), beUint(amount, 32));
}

/** Canonical ERC-721 `transferFrom(from, to, id)` calldata. */
export function buildErc721TransferFrom(from: string, to: string, id: bigint | number): Uint8Array {
  return concat(fromHex("23b872dd"), paddedAddress(from), paddedAddress(to), beUint(id, 32));
}

/** Canonical ERC-1155 `safeTransferFrom(from, to, id, amount, "")` calldata (empty data only, v1). */
export function buildErc1155SafeTransferFrom(
  from: string,
  to: string,
  id: bigint | number,
  amount: bigint | number,
): Uint8Array {
  return concat(
    fromHex("f242432a"),
    paddedAddress(from),
    paddedAddress(to),
    beUint(id, 32),
    beUint(amount, 32),
    beUint(0xa0, 32), // offset of empty bytes
    beUint(0, 32), // length 0
  );
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
