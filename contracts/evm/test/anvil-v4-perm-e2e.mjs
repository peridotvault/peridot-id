// V4 permission anvil loop: self-contained calldata + real P-256 signatures → live contracts.
//
// Proves the off-chain → on-chain loop for the permission layer independent of
// forge and of packages/* (ANT-201 owns the SDK builders; this script duplicates
// the V4 encodings it needs via `cast`, field-for-field with the contracts).
// Owner key = grants, session key = executions; raw RPC submits to anvil, and
// the script asserts receipts, balances, and event topics.
//
// Requires: forge-built artifacts (`forge build` in contracts/evm),
// python `ecdsa` on PYTHONPATH, `cast` on PATH, and a running anvil:
//   anvil &
//   node contracts/evm/test/anvil-v4-perm-e2e.mjs
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert, genKey, makeRpc, pidToSalt32, keccak,
  actPayloadV3, assertion, deployAndInitData,
  permissionId, grantPayload, permExecPayload, revokePayload,
  grantPermissionData, executeWithPermissionData, revokePermissionData, viewSel,
} from "./e2e-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVM_ROOT = join(HERE, "..");
const ANVIL = "http://127.0.0.1:8545";
const RELAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const GAS_PRICE = 10_000_000_000n;
const GAS_PRICE_HEX = "0x" + GAS_PRICE.toString(16);
const CHAINID = 31337;

const { rpc, receiptOf } = await makeRpc(ANVIL);
async function sendTx(tx) {
  const hash = await rpc("eth_sendTransaction", [{ gasPrice: GAS_PRICE_HEX, ...tx }]);
  return receiptOf(hash);
}

// --- deploy impl + factory ---
function deployBytecode(artifact, argsHex = "") {
  const j = JSON.parse(readFileSync(join(EVM_ROOT, "out", artifact + ".json"), "utf8"));
  return j.bytecode.object + argsHex;
}
const padAddr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const implDeploy = await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotAccount.sol/PeridotAccount") }]);
const impl = (await receiptOf(implDeploy)).contractAddress;
const factoryDeploy = await rpc("eth_sendTransaction", [{
  from: RELAYER,
  data: deployBytecode("PeridotFactory.sol/PeridotFactory",
    padAddr(impl) + padAddr(RELAYER) +
    "0000000000000000000000000000000000000000000000000000000000000060" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    padAddr(RELAYER)),
}]);
const factory = (await receiptOf(factoryDeploy)).contractAddress;
console.log("impl", impl, "factory", factory);

// --- two P-256 keypairs: owner (grants) + session (executions) ---
const owner = genKey();
const session = genKey();
const B = (hex) => Buffer.from(hex, "hex");
const U8 = (b) => b;
const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");

// --- activate (domain-free: no rpIdHash anywhere) ---
const salt = pidToSalt32("e2e-v4-perm@pid");
const saltHex = hex(salt);
const predicted = await rpc("eth_call", [{ to: factory, data: viewSel("predict(bytes32)") + saltHex.slice(2).padStart(64, "0") }, "latest"]);
const account = "0x" + predicted.slice(-40);
const deadline = Math.floor(Date.now() / 1000) + 300;
const actPayload = actPayloadV3({
  salt, x: B(owner.x), y: B(owner.y),
  feePolicyVersion: 1, deadline, chainId: CHAINID, factory,
});
const act = assertion(owner, actPayload);
const draftAct = deployAndInitData({
  salt, x: B(owner.x), y: B(owner.y),
  feePolicyVersion: 1, deadline, networkFee: 0n,
  authData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const actFee = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: factory, data: draftAct }])) * GAS_PRICE;
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: "0x" + ((actFee * 3n) / 2n).toString(16) }]);
const actRcpt = await sendTx({
  from: RELAYER, to: factory,
  data: deployAndInitData({
    salt, x: B(owner.x), y: B(owner.y),
    feePolicyVersion: 1, deadline, networkFee: actFee,
    authData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
  }),
});
assert.equal(actRcpt.status, "0x1", "activate");
console.log("activate OK", account);

// --- fund for ETH movement + fees ---
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: "0x" + (2n * 10n ** 18n).toString(16) }]);

// --- grant NONFINANCIAL (owner signs; local payload + calldata builders) ---
// ANT-556: v2 grant carries owner-approved feeLimit; v2 exec carries the
// session-signed maxTotalFee cap. The payload binds policy + cap but NOT the
// attested networkFee, so the estimate→attest dance below needs no re-signing
// as long as the final total fits the signed cap.
const now = Math.floor(Date.now() / 1000);
const FEE_LIMIT = 100_000_000_000_000_000n; // 0.1 ether lifetime session fees
const MAX_TOTAL = 10_000_000_000_000_000n; // 0.01 ether per-execution cap
const scope = {
  sessionX: B(session.x), sessionY: B(session.y),
  kind: 1, target: "0x0000000000000000000000000000000000001234",
  selector: B("12345678"),
  token: "0x0000000000000000000000000000000000000000",
  to: "0x0000000000000000000000000000000000000000",
  nftId: 0, validUntil: now + 7 * 86400, salt: crypto.randomBytes(32),
};
const pid = permissionId({ chainId: CHAINID, account, scope });
const grantP = grantPayload({
  chainId: CHAINID, account, permissionId: pid, scope, perTxCap: 0, totalLimit: 0,
  feeLimit: FEE_LIMIT, validAfter: now - 60, nonce: 0, deadline,
});
const g = assertion(owner, grantP);
const grantData = grantPermissionData({
  grant: {
    permissionId: pid, sessionX: scope.sessionX, sessionY: scope.sessionY, kind: scope.kind,
    target: scope.target, selector: scope.selector, token: scope.token, to: scope.to,
    perTxCap: 0n, totalLimit: 0n, feeLimit: FEE_LIMIT, nftId: 0n, validAfter: now - 60, validUntil: scope.validUntil,
    salt: scope.salt, deadline,
  },
  authData: g.authData, clientDataJSON: g.clientDataJSON, r: g.r, s: g.s,
});
const grantTopic = hex(keccak(Buffer.from("PermissionGranted(bytes32,bytes32,bytes32,uint8)", "ascii")));
const grantRcpt = await sendTx({ from: RELAYER, to: account, data: grantData });
assert.equal(grantRcpt.status, "0x1", "grantPermission: " + JSON.stringify(grantRcpt).slice(0, 300));
assert.ok(grantRcpt.logs.some((l) => l.topics[0].toLowerCase() === grantTopic.toLowerCase()), "PermissionGranted logged");
console.log("grant OK pid", hex(pid));

// --- session executes (local calldata, session signature) ---
const callData = B("12345678" + "00".repeat(32));
const execP = permExecPayload({
  chainId: CHAINID, account, permissionId: pid, seq: 0, target: scope.target, value: 0n,
  dataHash: keccak(callData), deadline, feePolicyVersion: 1, maxTotalFee: MAX_TOTAL,
});
const e = assertion(session, execP);
// Post-ANT-206 the on-chain GasAnomaly bound measures the full execute
// frame, so honest estimate x price attestation passes (same pattern as
// anvil-v3-e2e.mjs). Draft with zero fee, estimate, rebuild — the PERM
// payload binds policy + cap only, so no re-signing is needed.
const draftExec = executeWithPermissionData({
  permissionId: pid, target: scope.target, value: 0n, data: callData, deadline, seq: 0,
  feePolicyVersion: 1, maxTotalFee: MAX_TOTAL, networkFee: 0n,
  authenticatorData: e.authData, clientDataJSON: e.clientDataJSON, r: e.r, s: e.s,
});
const execFee = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: account, data: draftExec }])) * GAS_PRICE;
const execData = executeWithPermissionData({
  permissionId: pid, target: scope.target, value: 0n, data: callData, deadline, seq: 0,
  feePolicyVersion: 1, maxTotalFee: MAX_TOTAL, networkFee: execFee,
  authenticatorData: e.authData, clientDataJSON: e.clientDataJSON, r: e.r, s: e.s,
});
const execTopic = hex(keccak(Buffer.from("PermissionExecuted(bytes32,uint64,address,uint256)", "ascii")));
const execRcpt = await sendTx({ from: RELAYER, to: account, data: execData });
assert.equal(execRcpt.status, "0x1", "session exec: " + JSON.stringify(execRcpt).slice(0, 300));
assert.ok(execRcpt.logs.some((l) => l.topics[0].toLowerCase() === execTopic.toLowerCase()), "PermissionExecuted logged");
console.log("session exec OK");

// --- replay same seq reverts ---
const replayRcpt = await sendTx({ from: RELAYER, to: account, data: execData });
assert.equal(replayRcpt.status, "0x0", "seq replay reverts");
console.log("replay rejected OK");

// --- ANT-556 Option A: financial grant (kind 2) reverts at grant time ---
// A session key can never be granted asset movement again — the removal gate,
// live against real contracts.
const recipient = "0x000000000000000000000000000000000000dEaD";
const scope2 = {
  sessionX: scope.sessionX, sessionY: scope.sessionY, kind: 2,
  target: "0x0000000000000000000000000000000000000000", selector: B("00000000"),
  token: "0x0000000000000000000000000000000000000000", to: recipient,
  nftId: 0, validUntil: now + 7 * 86400, salt: crypto.randomBytes(32),
};
const pid2 = permissionId({ chainId: CHAINID, account, scope: scope2 });
const perTx = 200_000_000_000_000_000n;
const grant2P = grantPayload({
  chainId: CHAINID, account, permissionId: pid2, scope: scope2, perTxCap: perTx, totalLimit: perTx,
  feeLimit: FEE_LIMIT, validAfter: now - 60, nonce: 1, deadline,
});
const g2 = assertion(owner, grant2P);
const grant2Rcpt = await sendTx({
  from: RELAYER, to: account,
  data: grantPermissionData({
    grant: {
      permissionId: pid2, sessionX: scope2.sessionX, sessionY: scope2.sessionY, kind: 2,
      target: scope2.target, selector: scope2.selector, token: scope2.token, to: recipient,
      perTxCap: perTx, totalLimit: perTx, feeLimit: FEE_LIMIT, nftId: 0n, validAfter: now - 60, validUntil: scope2.validUntil,
      salt: scope2.salt, deadline,
    },
    authData: g2.authData, clientDataJSON: g2.clientDataJSON, r: g2.r, s: g2.s,
  }),
});
assert.equal(grant2Rcpt.status, "0x0", "financial grant reverts (Option A)");
console.log("financial grant rejected OK");

// --- maxTotalFee enforcement: cap below the attested total reverts ---
const tinyCapP = permExecPayload({
  chainId: CHAINID, account, permissionId: pid, seq: 1, target: scope.target, value: 0n,
  dataHash: keccak(callData), deadline, feePolicyVersion: 1, maxTotalFee: 1n,
});
const tc = assertion(session, tinyCapP);
const tinyCapRcpt = await sendTx({
  from: RELAYER, to: account,
  data: executeWithPermissionData({
    permissionId: pid, target: scope.target, value: 0n, data: callData, deadline, seq: 1,
    feePolicyVersion: 1, maxTotalFee: 1n, networkFee: execFee,
    authenticatorData: tc.authData, clientDataJSON: tc.clientDataJSON, r: tc.r, s: tc.s,
  }),
});
assert.equal(tinyCapRcpt.status, "0x0", "under-cap exec reverts");
console.log("maxTotalFee rejected OK");

// --- owner revokes (nonce 1 — the reverted grant consumed nothing); session exec reverts ---
const revokeP = revokePayload({ chainId: CHAINID, account, permissionId: pid, nonce: 2, deadline });
const rv = assertion(owner, revokeP);
const revokeRcpt = await sendTx({
  from: RELAYER, to: account,
  data: revokePermissionData({
    permissionId: pid, deadline,
    authData: rv.authData, clientDataJSON: rv.clientDataJSON, r: rv.r, s: rv.s,
  }),
});
assert.equal(revokeRcpt.status, "0x1", "revoke");
const exec3P = permExecPayload({
  chainId: CHAINID, account, permissionId: pid, seq: 1, target: scope.target, value: 0n,
  dataHash: keccak(callData), deadline, feePolicyVersion: 1, maxTotalFee: MAX_TOTAL,
});
const e3 = assertion(session, exec3P);
const postRevoke = await sendTx({
  from: RELAYER, to: account,
  data: executeWithPermissionData({
    permissionId: pid, target: scope.target, value: 0n, data: callData, deadline, seq: 1,
    feePolicyVersion: 1, maxTotalFee: MAX_TOTAL, networkFee: 0n,
    authenticatorData: e3.authData, clientDataJSON: e3.clientDataJSON, r: e3.r, s: e3.s,
  }),
});
assert.equal(postRevoke.status, "0x0", "post-revoke reverts");
console.log("revoke OK — all V4 anvil assertions passed");
