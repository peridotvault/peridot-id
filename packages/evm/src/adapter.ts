// EVM adapter — counterfactual smart accounts (mirrors SolanaAdapter surface).
// Address = CREATE2(factory, salt=keccak256(pidHash ‖ x ‖ y), proxy-of-implementation);
// B1 binding (ANT-866): the salt commits to the CLAIMING passkey, so only the
// bound address is a safe pre-funding target. Rotation never moves the address.

import {
  pidToSalt32,
  pidToPidHash,
  pidKeyToSalt32,
  assertNonfinancialKind,
  buildEvmAuthorizationPayload,
  buildEvmAuthorizationPayloadV2,
  buildEvmAuthorizationPayloadV3,
  buildEvmAuthorizationPayloadV4,
  buildEvmPermissionPayload,
  deriveEvmSmartAccountAddress,
  deriveEvmSmartAccountAddressBound,
  fromAscii,
  fromHex,
  keccak256,
  OP_EVM,
  OP_PERM,
  toHex,
} from "@peridotvault/pid-core/dist/evm";
import type { Bytes } from "@peridotvault/pid-core/dist/evm";
import type { EvmRpcLike } from "./rpc.js";

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

  /** Counterfactual address for a pidAccount.id (same on every chain sharing the factory).
   * @deprecated B1 (ANT-866): keyless derivation funds unclaimable addresses.
   * Use `getAddressBound` — retained for indexer reference only. */
  getAddress(pid: string): string {
    return deriveEvmSmartAccountAddress(pid, this.factory, this.implementation).address;
  }

  /** B1-bound counterfactual address for (pid, claiming key) — the only safe pre-funding target. */
  getAddressBound(pid: string, x: Bytes, y: Bytes): string {
    return deriveEvmSmartAccountAddressBound(pid, x, y, this.factory, this.implementation).address;
  }

  /** PID hash (`sha256(pid)`) — the first `deployAndInit` argument (the factory derives the salt). */
  getPidHash(pid: string): string {
    return "0x" + toHex(pidToPidHash(pid));
  }

  /** @deprecated B1 (ANT-866): returns the pid hash (formerly the raw salt). Use `getPidHash`. */
  getSalt(pid: string): string {
    return "0x" + toHex(pidToSalt32(pid));
  }

  /** B1-bound CREATE2 salt for (pid, claiming key) (for payload building / verification). */
  getSaltBound(pid: string, x: Bytes, y: Bytes): string {
    return "0x" + toHex(pidKeyToSalt32(pid, x, y));
  }

  /** True once the proxy is deployed (code present).
   * B1 (ANT-866/ANT-879): bound to (pid, claiming key) — the keyless address
   * is unclaimable, so probing it would report a false inactive. */
  async isDeployed(pid: string, x: Bytes, y: Bytes): Promise<boolean> {
    const code = await this.rpc.getCode(this.getAddressBound(pid, x, y));
    return code !== "0x" && code !== "0x0" && code.length > 2;
  }

  /** Balance of the B1-bound counterfactual (the only safe pre-funding target). */
  async getBalance(pid: string, x: Bytes, y: Bytes): Promise<bigint> {
    return this.rpc.getBalance(this.getAddressBound(pid, x, y));
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

  /** V3 `deployAndInit` calldata: passkey-bound activation (pidHash, authority,
   *  policy, deadline, networkFee + assertion). Matches the V3 factory:
   *  `deployAndInit(bytes32,bytes32,bytes32,uint16,uint64,uint256,bytes,bytes,bytes32,bytes32)`.
   *  B1 (ANT-866): the first field is the PID HASH, not a raw salt — the
   *  factory derives `salt = keccak256(pidHash ‖ x ‖ y)` on-chain.
   *  Static tail follows parameter order: offsets first, then r/s. */
  buildDeployAndInitDataV3(args: {
    pidHash: Bytes | string;
    x: Bytes;
    y: Bytes;
    feePolicyVersion: number;
    deadline: bigint | number;
    networkFee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const pidHashHex = typeof args.pidHash === "string" ? args.pidHash : "0x" + toHex(args.pidHash);
    const sel = "0x" + toHex(selector("deployAndInit(bytes32,bytes32,bytes32,uint16,uint64,uint256,bytes,bytes,bytes32,bytes32)"));
    const head = [
      pad32(pidHashHex),
      pad32("0x" + toHex(args.x)),
      pad32("0x" + toHex(args.y)),
      pad32("0x" + toHex(ube(args.feePolicyVersion, 2))),
      pad32("0x" + toHex(ube(args.deadline, 8))),
      pad32("0x" + toHex(ube(args.networkFee, 32))),
    ];
    const staticSize = 10 * 32;
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

  /** V3 activation authorization payload (no fee amounts — policy version only).
   * B1 (ANT-866): `salt` MUST be the bound salt (`pidKeyToSalt32` /
   * `getSaltBound`) — the contract enforces the binding (`SaltNotBound`). */
  buildActivatePayloadV3(args: {
    salt: Bytes | string;
    x: Bytes;
    y: Bytes;
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
      ube(args.feePolicyVersion, 2),
      ube(args.deadline, 8),
      ube(args.chainId, 32),
      hexBytes(args.factory, 20),
    ]);
  }

  /** eth_call data for the read-only poll checks (initialized/authorityX/authorityY/factory). */
  viewCalldata(): { initialized: string; authorityX: string; authorityY: string; factory: string } {
    return buildViewCalldata();
  }

  /** V4 `grantPermission` calldata (ANT-556: GrantArgs gains `feeLimit`).
   * SDK-side Option A gate: financial kinds throw before encoding.
   * Selector changes with the tuple — legacy v1 grant calldata is undecodable
   * on the new contract (fail-closed); pending v1 intents must be re-signed.
   */
  buildGrantPermissionData(args: {
    grant: {
      permissionId: Bytes;
      sessionX: Bytes;
      sessionY: Bytes;
      kind: number;
      target: string;
      selector: Bytes;
      token: string;
      to: string;
      perTxCap: bigint | number;
      totalLimit: bigint | number;
      feeLimit?: bigint | number;
      nftId: bigint | number;
      validAfter: bigint | number;
      validUntil: bigint | number;
      salt: Bytes;
      deadline: bigint | number;
    };
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sel = "0x" + toHex(selector("grantPermission((bytes32,bytes32,bytes32,uint8,address,bytes4,address,address,uint256,uint256,uint256,uint256,uint64,uint64,bytes32,uint64),bytes,bytes,bytes32,bytes32)"));
    const g = args.grant;
    assertNonfinancialKind(g.kind);
    mustBytes(g.permissionId, 32, "permissionId");
    mustBytes(g.sessionX, 32, "sessionX");
    mustBytes(g.sessionY, 32, "sessionY");
    mustBytes(g.selector, 4, "selector");
    mustBytes(g.salt, 32, "salt");
    constCoderCheck(args.authenticatorData, args.clientDataJSON, args.r, args.s);
    return sel + abiEncodeCall([
      {
        t: "tuple",
        fields: [
          { t: "bytes32", value: g.permissionId },
          { t: "bytes32", value: g.sessionX },
          { t: "bytes32", value: g.sessionY },
          { t: "uint", bytes: 1, value: g.kind },
          { t: "address", value: g.target },
          { t: "bytesN", bytes: 4, value: g.selector },
          { t: "address", value: g.token },
          { t: "address", value: g.to },
          { t: "uint", bytes: 32, value: g.perTxCap },
          { t: "uint", bytes: 32, value: g.totalLimit },
          { t: "uint", bytes: 32, value: g.feeLimit ?? 0n },
          { t: "uint", bytes: 32, value: g.nftId },
          { t: "uint", bytes: 8, value: g.validAfter },
          { t: "uint", bytes: 8, value: g.validUntil },
          { t: "bytes32", value: g.salt },
          { t: "uint", bytes: 8, value: g.deadline },
        ],
      },
      { t: "bytes", value: args.authenticatorData },
      { t: "bytes", value: args.clientDataJSON },
      { t: "bytes32", value: args.r },
      { t: "bytes32", value: args.s },
    ]);
  }

  /** V4 `revokePermission` calldata. */
  buildRevokePermissionData(args: {
    permissionId: Bytes;
    deadline: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sel = "0x" + toHex(selector("revokePermission(bytes32,uint64,bytes,bytes,bytes32,bytes32)"));
    mustBytes(args.permissionId, 32, "permissionId");
    return sel + abiEncodeCall([
      { t: "bytes32", value: args.permissionId },
      { t: "uint", bytes: 8, value: args.deadline },
      { t: "bytes", value: args.authenticatorData },
      { t: "bytes", value: args.clientDataJSON },
      { t: "bytes32", value: args.r },
      { t: "bytes32", value: args.s },
    ]);
  }

  /** V4 `executeWithPermission` calldata (frozen v1 overload: 12 args, no cap).
   * Serves legacy sunset executions only; new executions use
   * `buildExecuteWithPermissionDataV2`.
   */
  buildExecuteWithPermissionData(args: {
    permissionId: Bytes;
    target: string;
    value: bigint | number;
    data: Bytes;
    deadline: bigint | number;
    seq: bigint | number;
    feePolicyVersion: number;
    networkFee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sel = "0x" + toHex(selector("executeWithPermission(bytes32,address,uint256,bytes,uint64,uint64,uint16,uint256,bytes,bytes,bytes32,bytes32)"));
    mustBytes(args.permissionId, 32, "permissionId");
    return sel + abiEncodeCall([
      { t: "bytes32", value: args.permissionId },
      { t: "address", value: args.target },
      { t: "uint", bytes: 32, value: args.value },
      { t: "bytes", value: args.data },
      { t: "uint", bytes: 8, value: args.deadline },
      { t: "uint", bytes: 8, value: args.seq },
      { t: "uint", bytes: 2, value: args.feePolicyVersion },
      { t: "uint", bytes: 32, value: args.networkFee },
      { t: "bytes", value: args.authenticatorData },
      { t: "bytes", value: args.clientDataJSON },
      { t: "bytes32", value: args.r },
      { t: "bytes32", value: args.s },
    ]);
  }

  /** V4 `executeWithPermission` calldata (v2 overload: 13 args, `maxTotalFee` after `feePolicyVersion`). */
  buildExecuteWithPermissionDataV2(args: {
    permissionId: Bytes;
    target: string;
    value: bigint | number;
    data: Bytes;
    deadline: bigint | number;
    seq: bigint | number;
    feePolicyVersion: number;
    maxTotalFee: bigint | number;
    networkFee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sel = "0x" + toHex(selector("executeWithPermission(bytes32,address,uint256,bytes,uint64,uint64,uint16,uint256,uint256,bytes,bytes,bytes32,bytes32)"));
    mustBytes(args.permissionId, 32, "permissionId");
    return sel + abiEncodeCall([
      { t: "bytes32", value: args.permissionId },
      { t: "address", value: args.target },
      { t: "uint", bytes: 32, value: args.value },
      { t: "bytes", value: args.data },
      { t: "uint", bytes: 8, value: args.deadline },
      { t: "uint", bytes: 8, value: args.seq },
      { t: "uint", bytes: 2, value: args.feePolicyVersion },
      { t: "uint", bytes: 32, value: args.maxTotalFee },
      { t: "uint", bytes: 32, value: args.networkFee },
      { t: "bytes", value: args.authenticatorData },
      { t: "bytes", value: args.clientDataJSON },
      { t: "bytes32", value: args.r },
      { t: "bytes32", value: args.s },
    ]);
  }

  /** V4 `deployAndInitV4` calldata (fee-capped activation).
   * B1 (ANT-866): the first field is the PID HASH — the factory derives the
   * bound salt on-chain. */
  buildDeployAndInitDataV4(args: {
    pidHash: Bytes | string;
    x: Bytes;
    y: Bytes;
    feePolicyVersion: number;
    maxTotalFee: bigint | number;
    deadline: bigint | number;
    networkFee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const pidHashHex = typeof args.pidHash === "string" ? args.pidHash : "0x" + toHex(args.pidHash);
    const sel = "0x" + toHex(selector("deployAndInitV4(bytes32,bytes32,bytes32,uint16,uint256,uint64,uint256,bytes,bytes,bytes32,bytes32)"));
    const head = [
      pad32(pidHashHex),
      pad32("0x" + toHex(args.x)),
      pad32("0x" + toHex(args.y)),
      pad32("0x" + toHex(ube(args.feePolicyVersion, 2))),
      pad32("0x" + toHex(ube(args.maxTotalFee, 32))),
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

  /** V4 owner `executeV4` authorization payload (binds `maxTotalFee`). */
  buildExecutePayloadV4(args: {
    chainId: bigint | number;
    account: string;
    nonce: bigint | number;
    to: string;
    value: bigint | number;
    dataHash: Bytes;
    deadline: bigint | number;
    feePolicyVersion: number;
    maxTotalFee: bigint | number;
  }): Uint8Array {
    return buildEvmAuthorizationPayloadV4(OP_EVM.execute, [
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      ube(args.nonce, 8),
      hexBytes(args.to, 20),
      ube(args.value, 32),
      args.dataHash,
      ube(args.deadline, 8),
      ube(args.feePolicyVersion, 2),
      ube(args.maxTotalFee, 32),
    ]);
  }

  /** V4 owner `executeV4` calldata. */
  buildExecuteDataV4(args: {
    to: string;
    value: bigint | number;
    data: Bytes;
    deadline: bigint | number;
    feePolicyVersion: number;
    maxTotalFee: bigint | number;
    networkFee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sel = "0x" + toHex(selector("executeV4(address,uint256,bytes,uint64,uint16,uint256,uint256,bytes,bytes,bytes32,bytes32)"));
    const head = [encodeAddress(args.to), pad32("0x" + toHex(ube(args.value, 32)))];
    const staticSize = 11 * 32;
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
      pad32("0x" + toHex(ube(args.maxTotalFee, 32))),
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

  /** ERC-7579 `execute(bytes32,bytes)` calldata (auth packed inside per Exec7579Args). */
  build7579ExecuteData(args: { mode: Bytes; exec: Exec7579Tuple }): string {
    const sel = "0x" + toHex(selector("execute(bytes32,bytes)"));
    mustBytes(args.mode, 32, "mode");
    return sel + abiEncodeCall([{ t: "bytes32", value: args.mode }, { t: "tuple", fields: exec7579Fields(args.exec) }]);
  }

  /** ERC-7579 `executeV4(bytes32,bytes)` calldata (Exec7579Args + `maxTotalFee`). */
  build7579ExecuteDataV4(args: { mode: Bytes; exec: Exec7579TupleV4 }): string {
    const sel = "0x" + toHex(selector("executeV4(bytes32,bytes)"));
    mustBytes(args.mode, 32, "mode");
    return sel + abiEncodeCall([{ t: "bytes32", value: args.mode }, { t: "tuple", fields: exec7579FieldsV4(args.exec) }]);
  }

  /** ERC-7579 batch mode (mirrors `PeridotAccount.MODE_BATCH`): CallType 0x01
   * (batch) + ExecType 0x00 (default = atomic). Valid only on the v2
   * fee-capped 7579 entrypoints. */
  static readonly MODE_BATCH_HEX = "0x0100000000000000000000000000000000000000000000000000000000000000";

  /** `opsHash = keccak256(abi.encode(targets, values, datas))` — the exact
   * binding the contract recomputes for batch payloads. */
  buildBatchOpsHash(args: { targets: string[]; values: Array<bigint | number>; datas: Bytes[] }): Uint8Array {
    return keccak256(
      fromHex(
        abiEncodeCall([
          { t: "address[]", values: args.targets },
          { t: "uint256[]", values: args.values },
          { t: "bytes[]", values: args.datas },
        ]),
      ),
    );
  }

  /** V4 owner batch authorization payload (what the passkey signs as the
   * WebAuthn challenge for `executeV4(MODE_BATCH, …)`).
   * Field-for-field match of `_executeBatchV4`:
   * `keccak256(DOMAIN_PERM_V2 ‖ OP_EXEC7579 ‖ MODE_BATCH ‖ chainid ‖ account
   * ‖ nonce:uint64 ‖ opsHash ‖ deadline:uint64 ‖ feePolicyVersion:uint16 ‖
   * maxTotalFee)`. MODE_BATCH + opsHash bind the exact op array, so a
   * single-call signature can never verify as a batch (and vice versa). */
  buildBatchExecutePayloadV4(args: {
    chainId: bigint | number;
    account: string;
    nonce: bigint | number;
    opsHash: Bytes;
    deadline: bigint | number;
    feePolicyVersion: number;
    maxTotalFee: bigint | number;
  }): Uint8Array {
    mustBytes(args.opsHash, 32, "opsHash");
    return buildEvmPermissionPayload(OP_PERM.exec7579, [
      fromHex(EvmAdapter.MODE_BATCH_HEX.slice(2)),
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      ube(args.nonce, 8),
      args.opsHash,
      ube(args.deadline, 8),
      ube(args.feePolicyVersion, 2),
      ube(args.maxTotalFee, 32),
    ]);
  }

  /** V4 owner `executeV4(MODE_BATCH, …)` calldata.
   * Inner tuple: `abi.encode(targets[], values[], datas[], deadline,
   * feePolicyVersion, maxTotalFee, networkFee, authenticatorData,
   * clientDataJSON, r, s)` (field-for-field with `_executeBatchV4`). */
  buildBatchExecuteDataV4(args: {
    targets: string[];
    values: Array<bigint | number>;
    datas: Bytes[];
    deadline: bigint | number;
    feePolicyVersion: number;
    maxTotalFee: bigint | number;
    networkFee: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sel = "0x" + toHex(selector("executeV4(bytes32,bytes)"));
    constCoderCheck(args.authenticatorData, args.clientDataJSON, args.r, args.s);
    const inner = abiEncodeCall([
      { t: "address[]", values: args.targets },
      { t: "uint256[]", values: args.values },
      { t: "bytes[]", values: args.datas },
      { t: "uint", bytes: 8, value: args.deadline },
      { t: "uint", bytes: 2, value: args.feePolicyVersion },
      { t: "uint", bytes: 32, value: args.maxTotalFee },
      { t: "uint", bytes: 32, value: args.networkFee },
      { t: "bytes", value: args.authenticatorData },
      { t: "bytes", value: args.clientDataJSON },
      { t: "bytes32", value: args.r },
      { t: "bytes32", value: args.s },
    ]);
    const mode = fromHex(EvmAdapter.MODE_BATCH_HEX.slice(2));
    return sel + abiEncodeCall([{ t: "bytes32", value: mode }, { t: "bytes", value: fromHex(inner) }]);
  }

  /** V4 session batch authorization payload (what the session key signs for
   * `executeFromExecutorV2(MODE_BATCH, …)`).
   * Field-for-field match of `_executeBatchPermission`:
   * `keccak256(DOMAIN_PERM_V2 ‖ OP_PERM_EXEC ‖ MODE_BATCH ‖ chainid ‖ account
   * ‖ permissionId ‖ seq:uint64 ‖ opsHash ‖ deadline:uint64 ‖
   * feePolicyVersion:uint16 ‖ maxTotalFee)`. */
  buildBatchPermissionPayload(args: {
    chainId: bigint | number;
    account: string;
    permissionId: Bytes;
    seq: bigint | number;
    opsHash: Bytes;
    deadline: bigint | number;
    feePolicyVersion: number;
    maxTotalFee: bigint | number;
  }): Uint8Array {
    mustBytes(args.permissionId, 32, "permissionId");
    mustBytes(args.opsHash, 32, "opsHash");
    return buildEvmPermissionPayload(OP_PERM.permExec, [
      fromHex(EvmAdapter.MODE_BATCH_HEX.slice(2)),
      ube(args.chainId, 32),
      hexBytes(args.account, 20),
      args.permissionId,
      ube(args.seq, 8),
      args.opsHash,
      ube(args.deadline, 8),
      ube(args.feePolicyVersion, 2),
      ube(args.maxTotalFee, 32),
    ]);
  }

  /** V4 session `executeFromExecutorV2(MODE_BATCH, …)` calldata.
   * Inner tuple: `abi.encode(permissionId, targets[], values[], datas[],
   * deadline, seq, feePolicyVersion, maxTotalFee, networkFee, feeRecipient,
   * authenticatorData, clientDataJSON, r, s)` (field-for-field with
   * `_executeBatchPermission`). */
  buildBatchExecuteFromExecutorDataV2(args: {
    permissionId: Bytes;
    targets: string[];
    values: Array<bigint | number>;
    datas: Bytes[];
    deadline: bigint | number;
    seq: bigint | number;
    feePolicyVersion: number;
    maxTotalFee: bigint | number;
    networkFee: bigint | number;
    feeRecipient: string;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sel = "0x" + toHex(selector("executeFromExecutorV2(bytes32,bytes)"));
    mustBytes(args.permissionId, 32, "permissionId");
    constCoderCheck(args.authenticatorData, args.clientDataJSON, args.r, args.s);
    const inner = abiEncodeCall([
      { t: "bytes32", value: args.permissionId },
      { t: "address[]", values: args.targets },
      { t: "uint256[]", values: args.values },
      { t: "bytes[]", values: args.datas },
      { t: "uint", bytes: 8, value: args.deadline },
      { t: "uint", bytes: 8, value: args.seq },
      { t: "uint", bytes: 2, value: args.feePolicyVersion },
      { t: "uint", bytes: 32, value: args.maxTotalFee },
      { t: "uint", bytes: 32, value: args.networkFee },
      { t: "address", value: args.feeRecipient },
      { t: "bytes", value: args.authenticatorData },
      { t: "bytes", value: args.clientDataJSON },
      { t: "bytes32", value: args.r },
      { t: "bytes32", value: args.s },
    ]);
    const mode = fromHex(EvmAdapter.MODE_BATCH_HEX.slice(2));
    return sel + abiEncodeCall([{ t: "bytes32", value: mode }, { t: "bytes", value: fromHex(inner) }]);
  }

  /** ERC-7579 `executeFromExecutor(bytes32,bytes)` calldata (PermExecArgs tuple, frozen v1). */
  buildExecuteFromExecutorData(args: { mode: Bytes; exec: PermExecTuple }): string {
    const sel = "0x" + toHex(selector("executeFromExecutor(bytes32,bytes)"));
    mustBytes(args.mode, 32, "mode");
    return sel + abiEncodeCall([{ t: "bytes32", value: args.mode }, { t: "tuple", fields: permExecFields(args.exec) }]);
  }

  /** ERC-7579 `executeFromExecutorV2(bytes32,bytes)` calldata (PermExecArgs + `maxTotalFee`). */
  buildExecuteFromExecutorDataV2(args: { mode: Bytes; exec: PermExecTupleV2 }): string {
    const sel = "0x" + toHex(selector("executeFromExecutorV2(bytes32,bytes)"));
    mustBytes(args.mode, 32, "mode");
    return sel + abiEncodeCall([{ t: "bytes32", value: args.mode }, { t: "tuple", fields: permExecFieldsV2(args.exec) }]);
  }

  /** ERC-7579 `installModule` / `uninstallModule` calldata (owner assertion appended). */
  buildInstallModuleData(args: {
    uninstall: boolean;
    moduleTypeId: bigint | number;
    module: string;
    initData: Bytes;
    deadline: bigint | number;
    authenticatorData: Bytes;
    clientDataJSON: Bytes;
    r: Bytes;
    s: Bytes;
  }): string {
    const sig = args.uninstall
      ? "uninstallModule(uint256,address,bytes,uint64,bytes,bytes,bytes32,bytes32)"
      : "installModule(uint256,address,bytes,uint64,bytes,bytes,bytes32,bytes32)";
    const sel = "0x" + toHex(selector(sig));
    return sel + abiEncodeCall([
      { t: "uint", bytes: 32, value: args.moduleTypeId },
      { t: "address", value: args.module },
      { t: "bytes", value: args.initData },
      { t: "uint", bytes: 8, value: args.deadline },
      { t: "bytes", value: args.authenticatorData },
      { t: "bytes", value: args.clientDataJSON },
      { t: "bytes32", value: args.r },
      { t: "bytes32", value: args.s },
    ]);
  }

  /** ERC-1271 `isValidSignature` calldata (`signature` = abi.encode(authData, clientData, r, s)). */
  build1271Calldata(args: { hash: Bytes; authenticatorData: Bytes; clientDataJSON: Bytes; r: Bytes; s: Bytes }): string {
    const sel = "0x" + toHex(selector("isValidSignature(bytes32,bytes)"));
    mustBytes(args.hash, 32, "hash");
    const inner = abiEncodeCall([
      { t: "bytes", value: args.authenticatorData },
      { t: "bytes", value: args.clientDataJSON },
      { t: "bytes32", value: args.r },
      { t: "bytes32", value: args.s },
    ]);
    return sel + abiEncodeCall([{ t: "bytes32", value: args.hash }, { t: "bytes", value: fromHex(inner) }]);
  }

  /** Read-only V4 poll selectors (permission record, module flags, mode support). */
  viewCalldataV4(): {
    getPermission: string;
    isModuleInstalled: string;
    supportsModule: string;
    supportsExecutionMode: string;
    accountId: string;
  } {
    const sel = (sig: string) => "0x" + toHex(selector(sig));
    return {
      getPermission: sel("getPermission(bytes32)"),
      isModuleInstalled: sel("isModuleInstalled(uint256,address,bytes)"),
      supportsModule: sel("supportsModule(uint256)"),
      supportsExecutionMode: sel("supportsExecutionMode(bytes32)"),
      accountId: sel("accountId()"),
    };
  }
}

/** Standalone view calldata (no adapter instance needed — used by the API poll). */
export function buildViewCalldata(): {
  initialized: string;
  authorityX: string;
  authorityY: string;
  factory: string;
} {
  const sel = (sig: string) => "0x" + toHex(selector(sig));
  return {
    initialized: sel("initialized()"),
    authorityX: sel("authorityX()"),
    authorityY: sel("authorityY()"),
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

/** ABI-encode a 1-D array. `bytes[]` element offsets are relative to the
 * start of the array content (right after the length word), matching
 * `abi.encode` tuple-style dynamic encoding. Returns hex without 0x. */
function encodeArray(v: Extract<AbiValue, { t: "address[]" | "uint256[]" | "bytes[]" }>): string {
  const len = v.values.length;
  const lenWord = toHex(ube(len, 32));
  if (v.t === "address[]") {
    return lenWord + v.values.map((a) => encodeAddress(a)).join("");
  }
  if (v.t === "uint256[]") {
    return lenWord + v.values.map((n) => toHex(ube(n, 32))).join("");
  }
  const elemEncs = v.values.map((b) => encodeBytes(b));
  let head = "";
  let tailBytes = 0;
  for (const e of elemEncs) {
    head += toHex(ube(len * 32 + tailBytes, 32));
    tailBytes += e.length / 2;
  }
  return lenWord + head + elemEncs.join("");
}

function encBytes32(data: Bytes): string {
  if (data.length !== 32) throw new Error("expected 32 bytes");
  return toHex(data);
}

function constCoderCheck(authData: Bytes, clientData: Bytes, r: Bytes, s: Bytes): void {
  if (r.length !== 32 || s.length !== 32) throw new Error("r/s must be 32 bytes");
  if (authData.length === 0 || clientData.length === 0) throw new Error("assertion bytes required");
}

function mustBytes(v: Bytes, expected: number, name: string): void {
  if (v.length !== expected) throw new Error(`expected ${expected} bytes for ${name}`);
}

/** Minimal ABI coder: static scalars + `bytes` + nested tuples + 1-D arrays. */
export type AbiValue =
  | { t: "uint"; bytes: number; value: bigint | number }
  | { t: "address"; value: string }
  | { t: "bytes32"; value: Bytes }
  | { t: "bytesN"; bytes: number; value: Bytes }
  | { t: "bytes"; value: Bytes }
  | { t: "tuple"; fields: AbiValue[] }
  | { t: "address[]"; values: string[] }
  | { t: "uint256[]"; values: Array<bigint | number> }
  | { t: "bytes[]"; values: Bytes[] };

function isArrayValue(v: AbiValue): v is Extract<AbiValue, { t: "address[]" | "uint256[]" | "bytes[]" }> {
  return v.t === "address[]" || v.t === "uint256[]" || v.t === "bytes[]";
}

function isDynamic(v: AbiValue): boolean {
  return v.t === "bytes" || isArrayValue(v) || (v.t === "tuple" && v.fields.some(isDynamic));
}

function encodeStatic(v: AbiValue): string {
  switch (v.t) {
    case "uint":
      return toHex(ube(v.value, v.bytes)).padStart(64, "0").slice(-64);
    case "address":
      return encodeAddress(v.value);
    case "bytes32":
      mustBytes(v.value, 32, "bytes32");
      return toHex(v.value);
    case "bytesN": {
      if (v.value.length !== v.bytes) throw new Error(`expected ${v.bytes} bytes`);
      return (toHex(v.value) + "0".repeat(64)).slice(0, 64);
    }
    default:
      throw new Error("dynamic value has no static encoding");
  }
}

/** Encode a top-level arg list (or tuple fields): offsets relative to sequence start. Returns hex (no 0x). */
function abiEncodeSequence(values: AbiValue[]): string {
  const statics: string[] = [];
  const dynamics: string[] = [];
  let staticSize = 0;
  for (const v of values) {
    if (v.t !== "tuple" && !isDynamic(v)) staticSize += 32;
    else if (v.t === "tuple" && !v.fields.some(isDynamic)) staticSize += v.fields.length * 32;
    else staticSize += 32;
  }
  let tailBytes = 0;
  for (const v of values) {
    if (v.t === "tuple" && !v.fields.some(isDynamic)) {
      for (const f of v.fields) statics.push(encodeStatic(f));
      continue;
    }
    if (v.t !== "tuple" && !isDynamic(v)) {
      statics.push(encodeStatic(v));
      continue;
    }
    statics.push(toHex(ube(staticSize + tailBytes, 32)));
    if (v.t === "bytes") {
      const tail = encodeBytes(v.value);
      dynamics.push(tail);
      tailBytes += tail.length / 2;
    } else if (isArrayValue(v)) {
      const tail = encodeArray(v);
      dynamics.push(tail);
      tailBytes += tail.length / 2;
    } else if (v.t === "tuple") {
      const tail = abiEncodeSequence(v.fields);
      dynamics.push(tail);
      tailBytes += tail.length / 2;
    } else {
      throw new Error("unreachable: static value in dynamic slot");
    }
  }
  return statics.join("") + dynamics.join("");
}

/** Encode top-level call args (after the selector). Returns hex (no 0x). */
function abiEncodeCall(values: AbiValue[]): string {
  return abiEncodeSequence(values);
}

export interface Exec7579Tuple {
  target: string;
  value: bigint | number;
  data: Bytes;
  deadline: bigint | number;
  feePolicyVersion: number;
  networkFee: bigint | number;
  authenticatorData: Bytes;
  clientDataJSON: Bytes;
  r: Bytes;
  s: Bytes;
}

export interface PermExecTuple extends Exec7579Tuple {
  permissionId: Bytes;
  seq: bigint | number;
  feeRecipient: string;
}

/** V4 permission-execution tuple (adds the session-signed `maxTotalFee`). */
export interface PermExecTupleV2 extends PermExecTuple {
  maxTotalFee: bigint | number;
}

/** V4 owner-7579 tuple (adds the owner-signed `maxTotalFee`). */
export interface Exec7579TupleV4 extends Exec7579Tuple {
  maxTotalFee: bigint | number;
}

function exec7579Fields(e: Exec7579Tuple): AbiValue[] {
  return [
    { t: "address", value: e.target },
    { t: "uint", bytes: 32, value: e.value },
    { t: "bytes", value: e.data },
    { t: "uint", bytes: 8, value: e.deadline },
    { t: "uint", bytes: 2, value: e.feePolicyVersion },
    { t: "uint", bytes: 32, value: e.networkFee },
    { t: "bytes", value: e.authenticatorData },
    { t: "bytes", value: e.clientDataJSON },
    { t: "bytes32", value: e.r },
    { t: "bytes32", value: e.s },
  ];
}

function exec7579FieldsV4(e: Exec7579TupleV4): AbiValue[] {
  return [
    { t: "address", value: e.target },
    { t: "uint", bytes: 32, value: e.value },
    { t: "bytes", value: e.data },
    { t: "uint", bytes: 8, value: e.deadline },
    { t: "uint", bytes: 2, value: e.feePolicyVersion },
    { t: "uint", bytes: 32, value: e.maxTotalFee },
    { t: "uint", bytes: 32, value: e.networkFee },
    { t: "bytes", value: e.authenticatorData },
    { t: "bytes", value: e.clientDataJSON },
    { t: "bytes32", value: e.r },
    { t: "bytes32", value: e.s },
  ];
}

function permExecFields(e: PermExecTuple): AbiValue[] {
  return [
    { t: "bytes32", value: e.permissionId },
    { t: "address", value: e.target },
    { t: "uint", bytes: 32, value: e.value },
    { t: "bytes", value: e.data },
    { t: "uint", bytes: 8, value: e.deadline },
    { t: "uint", bytes: 8, value: e.seq },
    { t: "uint", bytes: 2, value: e.feePolicyVersion },
    { t: "uint", bytes: 32, value: e.networkFee },
    { t: "address", value: e.feeRecipient },
    { t: "bytes", value: e.authenticatorData },
    { t: "bytes", value: e.clientDataJSON },
    { t: "bytes32", value: e.r },
    { t: "bytes32", value: e.s },
  ];
}

function permExecFieldsV2(e: PermExecTupleV2): AbiValue[] {
  return [
    { t: "bytes32", value: e.permissionId },
    { t: "address", value: e.target },
    { t: "uint", bytes: 32, value: e.value },
    { t: "bytes", value: e.data },
    { t: "uint", bytes: 8, value: e.deadline },
    { t: "uint", bytes: 8, value: e.seq },
    { t: "uint", bytes: 2, value: e.feePolicyVersion },
    { t: "uint", bytes: 32, value: e.maxTotalFee },
    { t: "uint", bytes: 32, value: e.networkFee },
    { t: "address", value: e.feeRecipient },
    { t: "bytes", value: e.authenticatorData },
    { t: "bytes", value: e.clientDataJSON },
    { t: "bytes32", value: e.r },
    { t: "bytes32", value: e.s },
  ];
}

// Re-exported so callers keep one import (mirrors pid-solana index habit).
export { encodeAddress };
