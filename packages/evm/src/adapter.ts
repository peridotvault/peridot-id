// EVM adapter — counterfactual smart accounts (mirrors SolanaAdapter surface).
// Address = CREATE2(factory, salt=accountSeed, proxy-of-implementation); the
// passkey (x,y) is set on initialize, so rotation never moves the address.

import {
  pidToSalt32,
  buildEvmAuthorizationPayload,
  buildEvmAuthorizationPayloadV2,
  buildEvmAuthorizationPayloadV3,
  deriveEvmSmartAccountAddress,
  fromAscii,
  keccak256,
  OP_EVM,
  toHex,
} from "@peridotvault/pid-core/dist/evm";
import type { Bytes } from "@peridotvault/pid-core/dist/evm";
import type { EvmRpcLike } from "./rpc";

function selector(signature: string): Uint8Array {
  return keccak256(fromAscii(signature)).subarray(0, 4);
}

function pad32(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length > 64) throw new Error("abi value exceeds 32 bytes");
  return clean.padStart(64, "0");
}

function encodeAddress(address: string): string {
  const clean = address.startsWith("0x") ? address.slice(2).toLowerCase() : address.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error(`invalid evm address: ${address}`);
  return clean.padStart(64, "0");
}

/** Big-endian fixed-width integer (matches `abi.encodePacked`). */
function ube(value: bigint | number, bytes: number): Uint8Array {
  let v = BigInt(value);
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("evm abi value overflows width");
  return out;
}

export class EvmAdapter {
  constructor(
    private readonly rpc: EvmRpcLike,
    private readonly factory: string,
    private readonly implementation: string,
  ) {
    if (!factory || !implementation) throw new Error("evm factory + implementation required");
  }

  /** Counterfactual address for a pidAccount.id (same on every chain sharing the factory). */
  getAddress(pid: string): string {
    return deriveEvmSmartAccountAddress(pid, this.factory, this.implementation).address;
  }

  getSalt(pid: string): string {
    return "0x" + toHex(pidToSalt32(pid));
  }

  /** True once the proxy is deployed (code present). */
  async isDeployed(pid: string): Promise<boolean> {
    const code = await this.rpc.getCode(this.getAddress(pid));
    return code !== "0x" && code !== "0x0" && code.length > 2;
  }

  async getBalance(pid: string): Promise<bigint> {
    return this.rpc.getBalance(this.getAddress(pid));
  }

  /** `deployAndInit(bytes32,bytes32,bytes32,bytes32,uint256,address)` calldata for the relayer/forge script (V1, frozen). */
  buildDeployAndInitData(
    salt: Bytes | string,
    x: Bytes,
    y: Bytes,
    rpIdHash: Bytes,
    activationFee: bigint | number,
    treasury: string,
  ): string {
    const saltHex = typeof salt === "string" ? salt : "0x" + toHex(salt);
    const parts = [
      pad32(saltHex),
      pad32("0x" + toHex(x)),
      pad32("0x" + toHex(y)),
      pad32("0x" + toHex(rpIdHash)),
      pad32("0x" + toHex(ube(activationFee, 32))),
      encodeAddress(treasury),
    ];
    return "0x" + toHex(selector("deployAndInit(bytes32,bytes32,bytes32,bytes32,uint256,address)")) + parts.join("");
  }

  /** EVM authorization payload (what the passkey signs as the WebAuthn challenge) (V1, frozen). */
  buildExecutePayload(args: {
    chainId: bigint | number;
    account: string;
    nonce: bigint | number;
    to: string;
    value: bigint | number;
    dataHash: Bytes;
    deadline: bigint | number;
    relayFee: bigint | number;
    treasury: string;
  }): Uint8Array {
    // Field-for-field match of the contract's
    // `abi.encodePacked(DOMAIN, chainid, account, nonce:uint64, to, value, dataHash, deadline:uint64, relayFee, treasury)`.
    return buildEvmAuthorizationPayload([
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      ube(args.nonce, 8),
      hexBytes(args.to, 20),
      ube(args.value, 32),
      args.dataHash,
      ube(args.deadline, 8),
      ube(args.relayFee, 32),
      hexBytes(args.treasury, 20),
    ]);
  }

  /** V2 `deployAndInit` calldata: passkey-bound activation (salt, authority,
   *  rpIdHash, maxFee, policy, deadline, fee + assertion). Matches the V2 factory. */
  buildDeployAndInitDataV2(args: {
    salt: Bytes | string;
    x: Bytes;
    y: Bytes;
    rpIdHash: Bytes;
    maxFee: bigint | number;
    feePolicyVersion: number;
    deadline: bigint | number;
    fee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const saltHex = typeof args.salt === "string" ? args.salt : "0x" + toHex(args.salt);
    const sel = "0x" + toHex(selector("deployAndInit(bytes32,bytes32,bytes32,bytes32,uint256,uint16,uint64,uint256,bytes,bytes,bytes32,bytes32)"));
    const head = [
      pad32(saltHex),
      pad32("0x" + toHex(args.x)),
      pad32("0x" + toHex(args.y)),
      pad32("0x" + toHex(args.rpIdHash)),
      pad32("0x" + toHex(ube(args.maxFee, 32))),
      pad32("0x" + toHex(ube(args.feePolicyVersion, 2))),
      pad32("0x" + toHex(ube(args.deadline, 8))),
      pad32("0x" + toHex(ube(args.fee, 32))),
    ];
    // Dynamic params: offsets relative to the start of the encoding (after selector).
    // paddedLen includes the 32-byte length prefix.
    const staticSize = 12 * 32;
    const authData = args.authenticatorData;
    const clientData = args.clientDataJSON;
    constCoderCheck(authData, clientData, args.r, args.s);
    const off0 = staticSize;
    const off1 = off0 + paddedLen(authData.length);
    const enc0 = pad32("0x" + toHex(ube(off0, 32)));
    const enc1 = pad32("0x" + toHex(ube(off1, 32)));
    // Static tail follows PARAMETER order: offsets first, then r/s.
    const tail = [
      enc0,
      enc1,
      encBytes32(args.r),
      encBytes32(args.s),
      encodeBytes(authData),
      encodeBytes(clientData),
    ];
    return sel + head.join("") + tail.join("");
  }

  /** V2 EVM `execute` authorization payload (what the passkey signs as the challenge). */
  buildExecutePayloadV2(args: {
    chainId: bigint | number;
    account: string;
    nonce: bigint | number;
    to: string;
    value: bigint | number;
    dataHash: Bytes;
    deadline: bigint | number;
    maxFee: bigint | number;
    feePolicyVersion: number;
  }): Uint8Array {
    // Field-for-field match of the V2 contract's
    // `abi.encodePacked(DOMAIN_V2, opTag, chainid, account, nonce:uint64, to, value, dataHash, deadline:uint64, maxFee, feePolicyVersion:uint16)`.
    return buildEvmAuthorizationPayloadV2(OP_EVM.execute, [
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      ube(args.nonce, 8),
      hexBytes(args.to, 20),
      ube(args.value, 32),
      args.dataHash,
      ube(args.deadline, 8),
      ube(args.maxFee, 32),
      ube(args.feePolicyVersion, 2),
    ]);
  }

  /** V2 `updateAuthority` authorization payload (previously had no SDK builder). */
  buildUpdateAuthorityPayloadV2(args: {
    chainId: bigint | number;
    account: string;
    nonce: bigint | number;
    newX: Bytes;
    newY: Bytes;
    deadline: bigint | number;
  }): Uint8Array {
    return buildEvmAuthorizationPayloadV2(OP_EVM.updateAuthority, [
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      ube(args.nonce, 8),
      args.newX,
      args.newY,
      ube(args.deadline, 8),
    ]);
  }

  /** V2 activation authorization payload (what the new key signs for `deployAndInit`) (frozen). */
  buildActivatePayloadV2(args: {
    salt: Bytes | string;
    x: Bytes;
    y: Bytes;
    rpIdHash: Bytes;
    maxFee: bigint | number;
    feePolicyVersion: number;
    deadline: bigint | number;
    chainId: bigint | number;
    factory: string;
  }): Uint8Array {
    const saltBytes = typeof args.salt === "string" ? fromHexStrip0x(args.salt, 32) : args.salt;
    return buildEvmAuthorizationPayloadV2(OP_EVM.activate, [
      saltBytes,
      args.x,
      args.y,
      args.rpIdHash,
      ube(args.maxFee, 32),
      ube(args.feePolicyVersion, 2),
      ube(args.deadline, 8),
      ube(args.chainId, 32),
      hexBytes(args.factory, 20),
    ]);
  }

  /** V3 `deployAndInit` calldata: passkey-bound activation (salt, authority,
   *  rpIdHash, policy, deadline, networkFee + assertion). Matches the V3 factory:
   *  `deployAndInit(bytes32,bytes32,bytes32,bytes32,uint16,uint64,uint256,bytes,bytes,bytes32,bytes32)`.
   *  Static tail follows parameter order: offsets first, then r/s. */
  buildDeployAndInitDataV3(args: {
    salt: Bytes | string;
    x: Bytes;
    y: Bytes;
    rpIdHash: Bytes;
    feePolicyVersion: number;
    deadline: bigint | number;
    networkFee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const saltHex = typeof args.salt === "string" ? args.salt : "0x" + toHex(args.salt);
    const sel = "0x" + toHex(selector("deployAndInit(bytes32,bytes32,bytes32,bytes32,uint16,uint64,uint256,bytes,bytes,bytes32,bytes32)"));
    const head = [
      pad32(saltHex),
      pad32("0x" + toHex(args.x)),
      pad32("0x" + toHex(args.y)),
      pad32("0x" + toHex(args.rpIdHash)),
      pad32("0x" + toHex(ube(args.feePolicyVersion, 2))),
      pad32("0x" + toHex(ube(args.deadline, 8))),
      pad32("0x" + toHex(ube(args.networkFee, 32))),
    ];
    const staticSize = 11 * 32;
    const authData = args.authenticatorData;
    const clientData = args.clientDataJSON;
    constCoderCheck(authData, clientData, args.r, args.s);
    const off0 = staticSize;
    const off1 = off0 + paddedLen(authData.length);
    const tail = [
      pad32("0x" + toHex(ube(off0, 32))),
      pad32("0x" + toHex(ube(off1, 32))),
      encBytes32(args.r),
      encBytes32(args.s),
      encodeBytes(authData),
      encodeBytes(clientData),
    ];
    return sel + head.join("") + tail.join("");
  }

  /** V3 EVM `execute` authorization payload (no fee amounts — policy version only). */
  buildExecutePayloadV3(args: {
    chainId: bigint | number;
    account: string;
    nonce: bigint | number;
    to: string;
    value: bigint | number;
    dataHash: Bytes;
    deadline: bigint | number;
    feePolicyVersion: number;
  }): Uint8Array {
    // Field-for-field match of the V3 contract's
    // `abi.encodePacked(DOMAIN_V3, opTag, chainid, account, nonce:uint64, to, value, dataHash, deadline:uint64, feePolicyVersion:uint16)`.
    return buildEvmAuthorizationPayloadV3(OP_EVM.execute, [
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      ube(args.nonce, 8),
      hexBytes(args.to, 20),
      ube(args.value, 32),
      args.dataHash,
      ube(args.deadline, 8),
      ube(args.feePolicyVersion, 2),
    ]);
  }

  /** V3 `execute` calldata: `execute(address,uint256,bytes,uint64,uint16,uint256,bytes,bytes,bytes32,bytes32)`.
   *  Static tail follows parameter order: offsets first, then r/s. */
  buildExecuteDataV3(args: {
    to: string;
    value: bigint | number;
    data: Bytes;
    deadline: bigint | number;
    feePolicyVersion: number;
    networkFee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sel = "0x" + toHex(selector("execute(address,uint256,bytes,uint64,uint16,uint256,bytes,bytes,bytes32,bytes32)"));
    const head = [
      encodeAddress(args.to),
      pad32("0x" + toHex(ube(args.value, 32))),
    ];
    const staticSize = 10 * 32;
    const callData = args.data;
    const authData = args.authenticatorData;
    const clientData = args.clientDataJSON;
    constCoderCheck(authData, clientData, args.r, args.s);
    const offData = staticSize;
    const offAuth = offData + paddedLen(callData.length);
    const offClient = offAuth + paddedLen(authData.length);
    const tail = [
      pad32("0x" + toHex(ube(offData, 32))),
      pad32("0x" + toHex(ube(args.deadline, 8))),
      pad32("0x" + toHex(ube(args.feePolicyVersion, 2))),
      pad32("0x" + toHex(ube(args.networkFee, 32))),
      pad32("0x" + toHex(ube(offAuth, 32))),
      pad32("0x" + toHex(ube(offClient, 32))),
      encBytes32(args.r),
      encBytes32(args.s),
      encodeBytes(callData),
      encodeBytes(authData),
      encodeBytes(clientData),
    ];
    return sel + head.join("") + tail.join("");
  }

  /** V3 `updateAuthority` authorization payload (domain V3 only). */
  buildUpdateAuthorityPayloadV3(args: {
    chainId: bigint | number;
    account: string;
    nonce: bigint | number;
    newX: Bytes;
    newY: Bytes;
    deadline: bigint | number;
  }): Uint8Array {
    return buildEvmAuthorizationPayloadV3(OP_EVM.updateAuthority, [
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      ube(args.nonce, 8),
      args.newX,
      args.newY,
      ube(args.deadline, 8),
    ]);
  }

  /** V3 activation authorization payload (no fee amounts — policy version only). */
  buildActivatePayloadV3(args: {
    salt: Bytes | string;
    x: Bytes;
    y: Bytes;
    rpIdHash: Bytes;
    feePolicyVersion: number;
    deadline: bigint | number;
    chainId: bigint | number;
    factory: string;
  }): Uint8Array {
    const saltBytes = typeof args.salt === "string" ? fromHexStrip0x(args.salt, 32) : args.salt;
    return buildEvmAuthorizationPayloadV3(OP_EVM.activate, [
      saltBytes,
      args.x,
      args.y,
      args.rpIdHash,
      ube(args.feePolicyVersion, 2),
      ube(args.deadline, 8),
      ube(args.chainId, 32),
      hexBytes(args.factory, 20),
    ]);
  }

  /** eth_call data for the read-only poll checks (initialized/authorityX/authorityY/rpIdHash/factory). */
  viewCalldata(): { initialized: string; authorityX: string; authorityY: string; rpIdHash: string; factory: string } {
    return buildViewCalldata();
  }
}

/** Standalone view calldata (no adapter instance needed — used by the API poll). */
export function buildViewCalldata(): {
  initialized: string;
  authorityX: string;
  authorityY: string;
  rpIdHash: string;
  factory: string;
} {
  const sel = (sig: string) => "0x" + toHex(selector(sig));
  return {
    initialized: sel("initialized()"),
    authorityX: sel("authorityX()"),
    authorityY: sel("authorityY()"),
    rpIdHash: sel("rpIdHash()"),
    factory: sel("factory()"),
  };
}

function hexBytes(hex: string, expected: number): Uint8Array {
  const clean = (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
  if (clean.length !== expected * 2 || !/^[0-9a-f]*$/.test(clean)) {
    throw new Error(`expected ${expected}-byte hex: ${hex}`);
  }
  const out = new Uint8Array(expected);
  for (let i = 0; i < expected; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function fromHexStrip0x(hex: string, expected: number): Uint8Array {
  return hexBytes(hex, expected);
}

/** Padded length of a dynamic ABI value. */
function paddedLen(len: number): number {
  return 32 + Math.ceil(len / 32) * 32;
}

/** ABI-encode dynamic `bytes` (length word + right-padded data). Returns hex without 0x. */
function encodeBytes(data: Bytes): string {
  const len = data.length;
  const padded = Math.ceil(len / 32) * 32;
  const out = new Uint8Array(32 + padded);
  const view = new DataView(out.buffer);
  // Length as uint256 BE in the last 8 bytes (lengths here always fit).
  view.setUint32(28, len);
  out.set(data, 32);
  return toHex(out);
}

function encBytes32(data: Bytes): string {
  if (data.length !== 32) throw new Error("expected 32 bytes");
  return toHex(data);
}

function constCoderCheck(authData: Bytes, clientData: Bytes, r: Bytes, s: Bytes): void {
  if (r.length !== 32 || s.length !== 32) throw new Error("r/s must be 32 bytes");
  if (authData.length === 0 || clientData.length === 0) throw new Error("assertion bytes required");
}

// Re-exported so callers keep one import (mirrors pid-solana index habit).
export { encodeAddress };
