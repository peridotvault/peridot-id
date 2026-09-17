// V4 permission anvil loop: SDK-built calldata + real P-256 signatures → live contracts.
//
// Proves the off-chain → on-chain loop for the permission layer independent of forge:
// pid-core builds permissionId + grant/exec payloads, pid-evm builds grant/executeWithPermission
// calldata, python/`ecdsa` signs the raw digests (owner key = grants, session key = executions),
// raw RPC submits to anvil, and the script asserts receipts, balances, and event topics.
//
// Requires: forge-built artifacts (`forge build` in contracts/evm), python `ecdsa`,
// and a running anvil:  anvil &  node contracts/evm/test/anvil-v4-perm-e2e.mjs
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVM_ROOT = join(HERE, "..");
const ANVIL = "http://127.0.0.1:8545";
const RELAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const GAS_PRICE = 10_000_000_000n;
const GAS_PRICE_HEX = "0x" + GAS_PRICE.toString(16);
const RP_ID_HASH = crypto.createHash("sha256").update("localhost").digest();
const CHAINID = 31337;

async function rpc(method, params) {
  const res = await fetch(ANVIL, {
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
async function sendTx(tx) {
  const hash = await rpc("eth_sendTransaction", [{ gasPrice: GAS_PRICE_HEX, ...tx }]);
  const rcpt = await receiptOf(hash);
  return rcpt;
}

const core = await import("../../../packages/core/dist/evm.js");
const { EvmAdapter } = await import("../../../packages/evm/dist/adapter.js");
const U8 = (b) => new Uint8Array(b);
const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");

// --- deploy impl + factory ---
function deployBytecode(artifact, argsHex = "") {
  const j = JSON.parse(readFileSync(join(EVM_ROOT, "out", artifact + ".json"), "utf8"));
  return j.bytecode.object + argsHex;
}
const padAddr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const implDeploy = await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotAccount.sol/PeridotAccount") }]);
const impl = (await rpc("eth_getTransactionReceipt", [implDeploy])).contractAddress;
const factoryDeploy = await rpc("eth_sendTransaction", [{
  from: RELAYER,
  data: deployBytecode("PeridotFactory.sol/PeridotFactory",
    padAddr(impl) + padAddr(RELAYER) +
    "0000000000000000000000000000000000000000000000000000000000000060" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    padAddr(RELAYER)),
}]);
const factory = (await rpc("eth_getTransactionReceipt", [factoryDeploy])).contractAddress;
console.log("impl", impl, "factory", factory);

const adapter = new EvmAdapter({ getCode: async () => "0x", getBalance: async () => 0n }, factory, impl);

// --- two P-256 keypairs: owner (grants) + session (executions) ---
function genKey() {
  return JSON.parse(execSync(
    `python3 -c "import ecdsa,json; sk=ecdsa.SigningKey.generate(curve=ecdsa.NIST256p); vk=sk.get_verifying_key(); print(json.dumps({'priv':sk.to_string().hex(),'x':vk.pubkey.point.x().to_bytes(32,'big').hex(),'y':vk.pubkey.point.y().to_bytes(32,'big').hex()}))"`,
    { encoding: "utf8" },
  ));
}
const owner = genKey();
const session = genKey();
function signDigest(priv, hHex) {
  return Buffer.from(execSync(
    `python3 -c "import ecdsa; from ecdsa import util; sk=ecdsa.SigningKey.from_string(bytes.fromhex('${priv}'),curve=ecdsa.NIST256p); n=ecdsa.NIST256p.order; sig=sk.sign_digest(bytes.fromhex('${hHex}'),sigencode=util.sigencode_string); r,s=util.sigdecode_string(sig,n); s=n-s if s>n//2 else s; print((r.to_bytes(32,'big')+s.to_bytes(32,'big')).hex())"`,
    { encoding: "utf8" },
  ).trim(), "hex");
}
function assertion(key, payload) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: Buffer.from(payload).toString("base64url"), origin: "http://localhost:8081",
  }));
  const authData = Buffer.concat([RP_ID_HASH, Buffer.from([0x05, 0, 0, 0, 1])]);
  const h = crypto.createHash("sha256").update(Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()])).digest();
  const sig = signDigest(key.priv, h.toString("hex"));
  return { authData: U8(authData), clientDataJSON: U8(clientDataJSON), r: U8(sig.subarray(0, 32)), s: U8(sig.subarray(32)) };
}

// --- activate ---
const salt = core.pidToSalt32("e2e-v4-perm@pid");
const saltHex = hex(salt);
const sel = (s) => "0x" + Buffer.from(core.keccak256(core.fromAscii(s)).subarray(0, 4)).toString("hex");
const predicted = await rpc("eth_call", [{ to: factory, data: sel("predict(bytes32)") + saltHex.slice(2).padStart(64, "0") }, "latest"]);
const account = "0x" + predicted.slice(-40);
const deadline = Math.floor(Date.now() / 1000) + 300;
const actPayload = adapter.buildActivatePayloadV3({
  salt: saltHex, x: U8(Buffer.from(owner.x, "hex")), y: U8(Buffer.from(owner.y, "hex")),
  rpIdHash: U8(RP_ID_HASH), feePolicyVersion: 1, deadline, chainId: CHAINID, factory,
});
const act = assertion(owner, actPayload);
const draftAct = adapter.buildDeployAndInitDataV3({
  salt: saltHex, x: U8(Buffer.from(owner.x, "hex")), y: U8(Buffer.from(owner.y, "hex")),
  rpIdHash: U8(RP_ID_HASH), feePolicyVersion: 1, deadline, networkFee: 0n,
  authenticatorData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const actFee = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: factory, data: draftAct }])) * GAS_PRICE;
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: "0x" + ((actFee * 3n) / 2n).toString(16) }]);
const actRcpt = await sendTx({
  from: RELAYER, to: factory,
  data: adapter.buildDeployAndInitDataV3({
    salt: saltHex, x: U8(Buffer.from(owner.x, "hex")), y: U8(Buffer.from(owner.y, "hex")),
    rpIdHash: U8(RP_ID_HASH), feePolicyVersion: 1, deadline, networkFee: actFee,
    authenticatorData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
  }),
});
assert.equal(actRcpt.status, "0x1", "activate");
console.log("activate OK", account);

// --- fund for ETH movement + fees ---
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: "0x" + (2n * 10n ** 18n).toString(16) }]);

// --- grant NONFINANCIAL (owner signs; SDK builds id + payload + calldata) ---
const now = Math.floor(Date.now() / 1000);
const scope = {
  sessionX: U8(Buffer.from(session.x, "hex")), sessionY: U8(Buffer.from(session.y, "hex")),
  kind: 1, target: "0x0000000000000000000000000000000000001234",
  selector: U8(Buffer.from("12345678", "hex")),
  token: "0x0000000000000000000000000000000000000000",
  to: "0x0000000000000000000000000000000000000000",
  nftId: 0, validUntil: now + 7 * 86400, salt: U8(crypto.randomBytes(32)),
};
const pid = core.buildPermissionId(CHAINID, account, scope);
const grantPayload = core.buildGrantPayload({
  chainId: CHAINID, account, permissionId: pid, scope, perTxCap: 0, totalLimit: 0,
  validAfter: now - 60, nonce: 0, deadline,
});
const g = assertion(owner, grantPayload);
const grantData = adapter.buildGrantPermissionData({
  grant: {
    permissionId: pid, sessionX: scope.sessionX, sessionY: scope.sessionY, kind: scope.kind,
    target: scope.target, selector: scope.selector, token: scope.token, to: scope.to,
    perTxCap: 0n, totalLimit: 0n, nftId: 0n, validAfter: now - 60, validUntil: scope.validUntil,
    salt: scope.salt, deadline,
  },
  authenticatorData: g.authData, clientDataJSON: g.clientDataJSON, r: g.r, s: g.s,
});
const grantTopic = hex(core.keccak256(core.fromAscii("PermissionGranted(bytes32,bytes32,bytes32,uint8)")));
const grantRcpt = await sendTx({ from: RELAYER, to: account, data: grantData });
assert.equal(grantRcpt.status, "0x1", "grantPermission: " + JSON.stringify(grantRcpt).slice(0, 300));
assert.ok(grantRcpt.logs.some((l) => l.topics[0].toLowerCase() === grantTopic.toLowerCase()), "PermissionGranted logged");
console.log("grant OK pid", hex(pid));

// --- session executes (SDK calldata, session signature) ---
const callData = U8(Buffer.from("12345678" + "00".repeat(32), "hex"));
const execPayload = core.buildPermExecPayload({
  chainId: CHAINID, account, permissionId: pid, seq: 0, target: scope.target, value: 0n,
  dataHash: core.keccak256(callData), deadline, feePolicyVersion: 1,
});
const e = assertion(session, execPayload);
const draftExec = adapter.buildExecuteWithPermissionData({
  permissionId: pid, target: scope.target, value: 0n, data: callData, deadline, seq: 0,
  feePolicyVersion: 1, networkFee: 0n,
  authenticatorData: e.authData, clientDataJSON: e.clientDataJSON, r: e.r, s: e.s,
});
const execFee = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: account, data: draftExec }])) * GAS_PRICE;
const execData = adapter.buildExecuteWithPermissionData({
  permissionId: pid, target: scope.target, value: 0n, data: callData, deadline, seq: 0,
  feePolicyVersion: 1, networkFee: execFee,
  authenticatorData: e.authData, clientDataJSON: e.clientDataJSON, r: e.r, s: e.s,
});
const execTopic = hex(core.keccak256(core.fromAscii("PermissionExecuted(bytes32,uint64,address,uint256)")));
const execRcpt = await sendTx({ from: RELAYER, to: account, data: execData });
assert.equal(execRcpt.status, "0x1", "session exec: " + JSON.stringify(execRcpt).slice(0, 300));
assert.ok(execRcpt.logs.some((l) => l.topics[0].toLowerCase() === execTopic.toLowerCase()), "PermissionExecuted logged");
console.log("session exec OK");

// --- replay same seq reverts ---
const replayRcpt = await sendTx({ from: RELAYER, to: account, data: execData });
assert.equal(replayRcpt.status, "0x0", "seq replay reverts");
console.log("replay rejected OK");

// --- bounded ETH financial grant → session moves funds within caps ---
const recipient = "0x000000000000000000000000000000000000dEaD";
const scope2 = {
  sessionX: scope.sessionX, sessionY: scope.sessionY, kind: 2,
  target: "0x0000000000000000000000000000000000000000", selector: U8(Buffer.from("00000000", "hex")),
  token: "0x0000000000000000000000000000000000000000", to: recipient,
  nftId: 0, validUntil: now + 7 * 86400, salt: U8(crypto.randomBytes(32)),
};
const pid2 = core.buildPermissionId(CHAINID, account, scope2);
const perTx = 200_000_000_000_000_000n;
const grant2Payload = core.buildGrantPayload({
  chainId: CHAINID, account, permissionId: pid2, scope: scope2, perTxCap: perTx, totalLimit: perTx,
  validAfter: now - 60, nonce: 1, deadline,
});
const g2 = assertion(owner, grant2Payload);
const grant2Rcpt = await sendTx({
  from: RELAYER, to: account,
  data: adapter.buildGrantPermissionData({
    grant: {
      permissionId: pid2, sessionX: scope2.sessionX, sessionY: scope2.sessionY, kind: 2,
      target: scope2.target, selector: scope2.selector, token: scope2.token, to: recipient,
      perTxCap: perTx, totalLimit: perTx, nftId: 0n, validAfter: now - 60, validUntil: scope2.validUntil,
      salt: scope2.salt, deadline,
    },
    authenticatorData: g2.authData, clientDataJSON: g2.clientDataJSON, r: g2.r, s: g2.s,
  }),
});
assert.equal(grant2Rcpt.status, "0x1", "eth grant");
const emptyHash = core.keccak256(new Uint8Array(0));
const exec2Payload = core.buildPermExecPayload({
  chainId: CHAINID, account, permissionId: pid2, seq: 0, target: recipient, value: perTx,
  dataHash: emptyHash, deadline, feePolicyVersion: 1,
});
const e2 = assertion(session, exec2Payload);
const exec2Draft = adapter.buildExecuteWithPermissionData({
  permissionId: pid2, target: recipient, value: perTx, data: new Uint8Array(0), deadline, seq: 0,
  feePolicyVersion: 1, networkFee: 0n,
  authenticatorData: e2.authData, clientDataJSON: e2.clientDataJSON, r: e2.r, s: e2.s,
});
const exec2Fee = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: account, data: exec2Draft }])) * GAS_PRICE;
const balBefore = BigInt(await rpc("eth_getBalance", [recipient, "latest"]));
const exec2Rcpt = await sendTx({
  from: RELAYER, to: account,
  data: adapter.buildExecuteWithPermissionData({
    permissionId: pid2, target: recipient, value: perTx, data: new Uint8Array(0), deadline, seq: 0,
    feePolicyVersion: 1, networkFee: exec2Fee,
    authenticatorData: e2.authData, clientDataJSON: e2.clientDataJSON, r: e2.r, s: e2.s,
  }),
});
assert.equal(exec2Rcpt.status, "0x1", "eth session transfer");
assert.equal(BigInt(await rpc("eth_getBalance", [recipient, "latest"])) - balBefore, perTx, "recipient got exactly perTx");
console.log("bounded eth OK");

// --- over-cap session spend reverts ---
const overPayload = core.buildPermExecPayload({
  chainId: CHAINID, account, permissionId: pid2, seq: 1, target: recipient, value: perTx + 1n,
  dataHash: emptyHash, deadline, feePolicyVersion: 1,
});
const eo = assertion(session, overPayload);
const overRcpt = await sendTx({
  from: RELAYER, to: account,
  data: adapter.buildExecuteWithPermissionData({
    permissionId: pid2, target: recipient, value: perTx + 1n, data: new Uint8Array(0), deadline, seq: 1,
    feePolicyVersion: 1, networkFee: 0n,
    authenticatorData: eo.authData, clientDataJSON: eo.clientDataJSON, r: eo.r, s: eo.s,
  }),
});
assert.equal(overRcpt.status, "0x0", "over-cap reverts");
console.log("over-cap rejected OK");

// --- owner revokes (nonce 2); session exec reverts ---
const revokePayload = core.buildRevokePayload({ chainId: CHAINID, account, permissionId: pid, nonce: 2, deadline });
const rv = assertion(owner, revokePayload);
const revokeRcpt = await sendTx({
  from: RELAYER, to: account,
  data: adapter.buildRevokePermissionData({
    permissionId: pid, deadline,
    authenticatorData: rv.authData, clientDataJSON: rv.clientDataJSON, r: rv.r, s: rv.s,
  }),
});
assert.equal(revokeRcpt.status, "0x1", "revoke");
const exec3Payload = core.buildPermExecPayload({
  chainId: CHAINID, account, permissionId: pid, seq: 1, target: scope.target, value: 0n,
  dataHash: core.keccak256(callData), deadline, feePolicyVersion: 1,
});
const e3 = assertion(session, exec3Payload);
const postRevoke = await sendTx({
  from: RELAYER, to: account,
  data: adapter.buildExecuteWithPermissionData({
    permissionId: pid, target: scope.target, value: 0n, data: callData, deadline, seq: 1,
    feePolicyVersion: 1, networkFee: 0n,
    authenticatorData: e3.authData, clientDataJSON: e3.clientDataJSON, r: e3.r, s: e3.s,
  }),
});
assert.equal(postRevoke.status, "0x0", "post-revoke reverts");
console.log("revoke OK — all V4 anvil assertions passed");
