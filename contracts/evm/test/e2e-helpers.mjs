// Shared helpers for the contracts-owned anvil loop tests (ANT-200, ANT-197
// domain-free). Fully self-contained: NO imports from packages/* (those live
// under ANT-201 ownership). Needs: forge-built artifacts (`forge build` in
// contracts/evm), a running anvil, `cast` on PATH, and python `ecdsa`
// (PYTHONPATH must point at it, e.g. `pip install ecdsa`).
//
// Domain-free (ANT-197): no RP-ID hash appears in any payload or calldata.
// Authenticator prefixes are neutral test bytes; origins are scheme-free
// (`test.invalid`) — the programs only extract the `challenge` field.
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

export const CAST = process.env.CAST_BIN || "cast";

// --- P-256 (python ecdsa, raw-digest sign + low-S; node:crypto re-hashes) ---

export function genKey() {
  return JSON.parse(execSync(
    `python3 -c "import ecdsa,json; sk=ecdsa.SigningKey.generate(curve=ecdsa.NIST256p); vk=sk.get_verifying_key(); print(json.dumps({'priv':sk.to_string().hex(),'x':vk.pubkey.point.x().to_bytes(32,'big').hex(),'y':vk.pubkey.point.y().to_bytes(32,'big').hex()}))"`,
    { encoding: "utf8" },
  ));
}

export function signDigest(privHex, hHex) {
  return Buffer.from(execSync(
    `python3 -c "import ecdsa; from ecdsa import util; sk=ecdsa.SigningKey.from_string(bytes.fromhex('${privHex}'),curve=ecdsa.NIST256p); n=ecdsa.NIST256p.order; sig=sk.sign_digest(bytes.fromhex('${hHex}'),sigencode=util.sigencode_string); r,s=util.sigdecode_string(sig,n); s=n-s if s>n//2 else s; print((r.to_bytes(32,'big')+s.to_bytes(32,'big')).hex())"`,
    { encoding: "utf8" },
  ).trim(), "hex");
}

// --- hashing / encoding ---

export const sha256 = (b) => crypto.createHash("sha256").update(b).digest();
export const b64url = (b) => Buffer.from(b).toString("base64url");
export const pidToSalt32 = (pid) => sha256(Buffer.from(pid.trim().toLowerCase(), "utf8"));

// keccak256 via cast (single binary, no JS dep).
export function keccak(buf) {
  const out = execSync(`${CAST} keccak 0x${Buffer.from(buf).toString("hex")}`, { encoding: "utf8" }).trim();
  return Buffer.from(out.slice(2), "hex");
}

const u8 = (v, n) => {
  let x = BigInt(v);
  if (x < 0n) throw new Error("negative uint");
  const b = Buffer.alloc(n);
  for (let i = n - 1; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  if (x !== 0n) throw new Error("uint overflow");
  return b;
};

const addrBuf = (a) => Buffer.from(a.slice(2).toLowerCase().padStart(40, "0"), "hex");
const b32 = (b) => Buffer.from(b).length === 32 ? Buffer.from(b) : (() => { throw new Error("need 32 bytes"); })();

// --- WebAuthn assertion (neutral prefix + scheme-free origin) ---

export const AUTH_PREFIX = sha256(Buffer.from("test-rp", "utf8"));

export function assertion(key, payload) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: b64url(payload), origin: "test.invalid",
  }));
  const authData = Buffer.concat([AUTH_PREFIX, Buffer.from([0x05, 0, 0, 0, 1])]);
  const h = sha256(Buffer.concat([authData, sha256(clientDataJSON)]));
  const sig = signDigest(key.priv, h.toString("hex"));
  return { authData, clientDataJSON, r: sig.subarray(0, 32), s: sig.subarray(32) };
}

// --- RPC ---

export async function makeRpc(anvilUrl) {
  async function rpc(method, params) {
    const res = await fetch(anvilUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await res.json();
    if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  async function receiptOf(hash) {
    for (let i = 0; i < 40; i++) {
      const r = await rpc("eth_getTransactionReceipt", [hash]);
      if (r) return r;
      await new Promise((r2) => setTimeout(r2, 250));
    }
    throw new Error("no receipt for " + hash);
  }
  return { rpc, receiptOf };
}

// --- V3 activation payload (domain-free): DOMAIN_V3 ‖ 0x05 ‖ salt ‖ x ‖ y ‖
/// policy u16 ‖ deadline u64 ‖ chainid u256 ‖ factory (all BE, packed) ---

export const DOMAIN_V3 = Buffer.from("PID|EVM|SMART_ACCOUNT|v3", "ascii");
const DOMAIN_PERM = Buffer.from("PID|EVM|PERMISSION|v1", "ascii");

export function actPayloadV3({ salt, x, y, feePolicyVersion, deadline, chainId, factory }) {
  return keccak(Buffer.concat([
    DOMAIN_V3, Buffer.from([0x05]),
    b32(salt), b32(x), b32(y),
    u8(feePolicyVersion, 2), u8(deadline, 8), u8(chainId, 32),
    addrBuf(factory),
  ]));
}

// --- V3 execute payload (unchanged by ANT-197; kept here for hermeticity) ---

export function exePayloadV3({ chainId, account, nonce, to, value, dataHash, deadline, feePolicyVersion }) {
  return keccak(Buffer.concat([
    DOMAIN_V3, Buffer.from([0x01]),
    u8(chainId, 32), addrBuf(account), u8(nonce, 8),
    addrBuf(to), u8(value, 32), b32(dataHash),
    u8(deadline, 8), u8(feePolicyVersion, 2),
  ]));
}

// --- calldata via cast (exact on-chain signatures) ---

const hx = (b) => "0x" + Buffer.from(b).toString("hex");

export function deployAndInitData({ salt, x, y, feePolicyVersion, deadline, networkFee, authData, clientDataJSON, r, s }) {
  return execSync(
    `${CAST} calldata "deployAndInit(bytes32,bytes32,bytes32,uint16,uint64,uint256,bytes,bytes,bytes32,bytes32)" ` +
    `${hx(salt)} ${hx(x)} ${hx(y)} ${feePolicyVersion} ${deadline} ${networkFee} ${hx(authData)} ${hx(clientDataJSON)} ${hx(r)} ${hx(s)}`,
    { encoding: "utf8" },
  ).trim();
}

export function executeData({ to, value, data, deadline, feePolicyVersion, networkFee, authData, clientDataJSON, r, s }) {
  return execSync(
    `${CAST} calldata "execute(address,uint256,bytes,uint64,uint16,uint256,bytes,bytes,bytes32,bytes32)" ` +
    `${to} ${value} ${hx(data)} ${deadline} ${feePolicyVersion} ${networkFee} ${hx(authData)} ${hx(clientDataJSON)} ${hx(r)} ${hx(s)}`,
    { encoding: "utf8" },
  ).trim();
}

export function viewSel(sig) {
  return ("0x" + keccak(Buffer.from(sig, "ascii")).subarray(0, 4).toString("hex"));
}

// --- V4 permission payloads (field-for-field with packages/core/src/evm.ts;
// schemas untouched by ANT-197/ANT-201; duplicated here for hermeticity) ---

export function permissionId({ chainId, account, scope }) {
  return keccak(Buffer.concat([
    DOMAIN_PERM,
    u8(chainId, 32), addrBuf(account),
    b32(scope.sessionX), b32(scope.sessionY), Buffer.from([scope.kind & 0xff]),
    addrBuf(scope.target), Buffer.from(scope.selector),
    addrBuf(scope.token), addrBuf(scope.to),
    u8(scope.nftId, 32), u8(scope.validUntil, 8), b32(scope.salt),
  ]));
}

export function grantPayload({ chainId, account, permissionId: pid, scope, perTxCap, totalLimit, validAfter, nonce, deadline }) {
  return keccak(Buffer.concat([
    DOMAIN_PERM, Buffer.from([0x10]),
    u8(chainId, 32), addrBuf(account), b32(pid),
    b32(scope.sessionX), b32(scope.sessionY), Buffer.from([scope.kind & 0xff]),
    addrBuf(scope.target), Buffer.from(scope.selector),
    addrBuf(scope.token), addrBuf(scope.to),
    u8(perTxCap, 32), u8(totalLimit, 32), u8(scope.nftId, 32),
    u8(validAfter, 8), u8(scope.validUntil, 8), u8(nonce, 8), u8(deadline, 8),
  ]));
}

export function permExecPayload({ chainId, account, permissionId: pid, seq, target, value, dataHash, deadline, feePolicyVersion }) {
  return keccak(Buffer.concat([
    DOMAIN_PERM, Buffer.from([0x12]),
    u8(chainId, 32), addrBuf(account), b32(pid),
    u8(seq, 8), addrBuf(target), u8(value, 32), b32(dataHash),
    u8(deadline, 8), u8(feePolicyVersion, 2),
  ]));
}

export function revokePayload({ chainId, account, permissionId: pid, nonce, deadline }) {
  return keccak(Buffer.concat([
    DOMAIN_PERM, Buffer.from([0x11]),
    u8(chainId, 32), addrBuf(account), b32(pid),
    u8(nonce, 8), u8(deadline, 8),
  ]));
}

export function grantPermissionData({ grant, authData, clientDataJSON, r, s }) {
  const g = grant;
  const tuple = `(${hx(g.permissionId)},${hx(g.sessionX)},${hx(g.sessionY)},${g.kind},${g.target},0x${Buffer.from(g.selector).toString("hex")},${g.token},${g.to},${g.perTxCap},${g.totalLimit},${g.nftId},${g.validAfter},${g.validUntil},${hx(g.salt)},${g.deadline})`;
  return execSync(
    `${CAST} calldata "grantPermission((bytes32,bytes32,bytes32,uint8,address,bytes4,address,address,uint256,uint256,uint256,uint64,uint64,bytes32,uint64),bytes,bytes,bytes32,bytes32)" ` +
    `"${tuple}" ${hx(authData)} ${hx(clientDataJSON)} ${hx(r)} ${hx(s)}`,
    { encoding: "utf8", maxBuffer: 1 << 20 },
  ).trim();
}

export function executeWithPermissionData(a) {
  return execSync(
    `${CAST} calldata "executeWithPermission(bytes32,address,uint256,bytes,uint64,uint64,uint16,uint256,bytes,bytes,bytes32,bytes32)" ` +
    `${hx(a.permissionId)} ${a.target} ${a.value} ${hx(a.data)} ${a.deadline} ${a.seq} ${a.feePolicyVersion} ${a.networkFee} ${hx(a.authenticatorData)} ${hx(a.clientDataJSON)} ${hx(a.r)} ${hx(a.s)}`,
    { encoding: "utf8", maxBuffer: 1 << 20 },
  ).trim();
}

export function revokePermissionData({ permissionId, deadline, authData, clientDataJSON, r, s }) {
  return execSync(
    `${CAST} calldata "revokePermission(bytes32,uint64,bytes,bytes,bytes32,bytes32)" ` +
    `${hx(permissionId)} ${deadline} ${hx(authData)} ${hx(clientDataJSON)} ${hx(r)} ${hx(s)}`,
    { encoding: "utf8" },
  ).trim();
}

export { assert };
