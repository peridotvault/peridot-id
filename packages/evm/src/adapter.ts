// EVM adapter — counterfactual smart accounts (mirrors SolanaAdapter surface).
// Address = CREATE2(factory, salt=accountSeed, proxy-of-implementation); the
// passkey (x,y) is set on initialize, so rotation never moves the address.

import {
  accountIdToSalt32,
  buildEvmAuthorizationPayload,
  deriveEvmSmartAccountAddress,
  fromAscii,
  keccak256,
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
  getAddress(accountId: string): string {
    return deriveEvmSmartAccountAddress(accountId, this.factory, this.implementation).address;
  }

  getSalt(accountId: string): string {
    return "0x" + toHex(accountIdToSalt32(accountId));
  }

  /** True once the proxy is deployed (code present). */
  async isDeployed(accountId: string): Promise<boolean> {
    const code = await this.rpc.getCode(this.getAddress(accountId));
    return code !== "0x" && code !== "0x0" && code.length > 2;
  }

  async getBalance(accountId: string): Promise<bigint> {
    return this.rpc.getBalance(this.getAddress(accountId));
  }

  /** `deployAndInit(bytes32,bytes32,bytes32,bytes32)` calldata for the relayer/forge script. */
  buildDeployAndInitData(salt: Bytes | string, x: Bytes, y: Bytes, rpIdHash: Bytes): string {
    const saltHex = typeof salt === "string" ? salt : "0x" + toHex(salt);
    const parts = [pad32(saltHex), pad32("0x" + toHex(x)), pad32("0x" + toHex(y)), pad32("0x" + toHex(rpIdHash))];
    return "0x" + toHex(selector("deployAndInit(bytes32,bytes32,bytes32,bytes32)")) + parts.join("");
  }

  /** EVM authorization payload (what the passkey signs as the WebAuthn challenge). */
  buildExecutePayload(args: {
    chainId: bigint | number;
    account: string;
    nonce: bigint | number;
    to: string;
    value: bigint | number;
    dataHash: Bytes;
    deadline: bigint | number;
  }): Uint8Array {
    // Field-for-field match of the contract's
    // `abi.encodePacked(DOMAIN, chainid, account, nonce:uint64, to, value, dataHash, deadline:uint64)`.
    return buildEvmAuthorizationPayload([
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      ube(args.nonce, 8),
      hexBytes(args.to, 20),
      ube(args.value, 32),
      args.dataHash,
      ube(args.deadline, 8),
    ]);
  }
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

// Re-exported so callers keep one import (mirrors pid-solana index habit).
export { encodeAddress };
