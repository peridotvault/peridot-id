// V4 batch anvil loop: MODE_BATCH owner + session execution against live contracts.
//
// Proves the off-chain → on-chain loop for PeridotAccountBatch independent of
// forge and of packages/*: real P-256 signatures, raw RPC submits to anvil,
// receipt + topic + state assertions. Covers the 19:06 EIP-170-split scope:
// V4 activation, module install, grant, owner batch (BatchExecuted +
// 2×BatchOpExecuted + scores + nonce), session batch via executor
// (PermissionBatchExecuted + seq-once replay revert), atomicity revert with no
// state/nonce change, fee-cap enforcement, and scope-per-op denial with seq-1
// recovery.
//
// Requires: forge-built artifacts (`forge build` in contracts/evm),
// python `ecdsa` on PYTHONPATH, `cast` on PATH, and a running anvil:
//   anvil &
//   node contracts/evm/test/anvil-v4-batch-e2e.mjs
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert, genKey, makeRpc, pidToSalt32, keccak,
  actPayloadV4, deployAndInitV4Data, assertion,
  opsHash, batchOwnerPayload, batchSessionPayload,
  batchOwnerInner, batchSessionInner,
  executeBatchV4Data, executeViaPermissionV2Data,
  installPayload, installModuleData,
  permissionId, grantPayload, grantPermissionData, viewSel,
} from "./e2e-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVM_ROOT = join(HERE, "..");
const ANVIL = "http://127.0.0.1:8545";
// Factory admin (revenue drain only — no creation privilege since ANT-610).
const RELAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Independent submitter (anvil account #1).
const SUBMITTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const GAS_PRICE = 10_000_000_000n;
const GAS_PRICE_HEX = "0x" + GAS_PRICE.toString(16);
// Even-length hex: anvil rejects odd-length `value` quantities.
const weiHex = (v) => { const h = v.toString(16); return "0x" + (h.length % 2 ? "0" + h : h); };
const CHAINID = 31337;

const { rpc, receiptOf } = await makeRpc(ANVIL);
async function sendTx(tx) {
  const hash = await rpc("eth_sendTransaction", [{ gasPrice: GAS_PRICE_HEX, ...tx }]);
  return receiptOf(hash);
}

// --- deploy batch impl + factory ---
function deployBytecode(artifact, argsHex = "") {
  const j = JSON.parse(readFileSync(join(EVM_ROOT, "out", artifact + ".json"), "utf8"));
  return j.bytecode.object + argsHex;
}
const padAddr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const batchImplDeploy = await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotAccountBatch.sol/PeridotAccountBatch") }]);
const batchImpl = (await receiptOf(batchImplDeploy)).contractAddress;
const factoryDeploy = await rpc("eth_sendTransaction", [{
  from: RELAYER,
  // constructor(implementation, admins[]) — no relayer allowlist since ANT-610.
  data: deployBytecode("PeridotFactory.sol/PeridotFactory",
    padAddr(batchImpl) +
    "0000000000000000000000000000000000000000000000000000000000000040" +
    "0000000000000000000000000000000000000000000000000000000000000001" +
    padAddr(RELAYER)),
}]);
const factory = (await receiptOf(factoryDeploy)).contractAddress;
console.log("batchImpl", batchImpl, "factory", factory);

// Fund the independent submitter (gas money only).
await rpc("eth_sendTransaction", [{ from: RELAYER, to: SUBMITTER, value: weiHex(10n ** 18n) }]);

// --- two P-256 keypairs: owner (grants + owner batch) + session (session batch) ---
const owner = genKey();
const session = genKey();
const B = (hex) => Buffer.from(hex, "hex");
const hex = (u8) => "0x" + Buffer.from(u8).toString("hex");

// --- V4 activation (deployAndInitV4; generous cap, estimate pattern) ---
const salt = pidToSalt32("e2e-v4-batch@pid");
const saltHex = hex(salt);
const predicted = await rpc("eth_call", [{ to: factory, data: viewSel("predict(bytes32)") + saltHex.slice(2).padStart(64, "0") }, "latest"]);
const account = "0x" + predicted.slice(-40);
const deadline = Math.floor(Date.now() / 1000) + 300;
const ACT_CAP = 50_000_000_000_000_000n; // 0.05 ETH activation cap (generous; payload-bound)
const actPayload = actPayloadV4({
  salt, x: B(owner.x), y: B(owner.y),
  feePolicyVersion: 1, maxTotalFee: ACT_CAP, deadline, chainId: CHAINID, factory,
});
const act = assertion(owner, actPayload);
const draftAct = deployAndInitV4Data({
  salt, x: B(owner.x), y: B(owner.y),
  feePolicyVersion: 1, maxTotalFee: ACT_CAP, deadline, networkFee: 0n,
  authData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const actFee = BigInt(await rpc("eth_estimateGas", [{ from: SUBMITTER, to: factory, data: draftAct }])) * GAS_PRICE;
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: weiHex((actFee * 3n) / 2n) }]);
const actRcpt = await sendTx({
  from: SUBMITTER, to: factory,
  data: deployAndInitV4Data({
    salt, x: B(owner.x), y: B(owner.y),
    feePolicyVersion: 1, maxTotalFee: ACT_CAP, deadline, networkFee: actFee,
    authData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
  }),
});
assert.equal(actRcpt.status, "0x1", "V4 activate");
console.log("activate OK", account);

// --- fund for movement + fees; deploy game + executor targets ---
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: weiHex(2n * 10n ** 18n) }]);
const gameDeploy = await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotBatch.t.sol/MockGame") }]);
const game = (await receiptOf(gameDeploy)).contractAddress;
const execDeploy = await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotPermissionExecutor.sol/PeridotPermissionExecutor") }]);
const executor = (await receiptOf(execDeploy)).contractAddress;
console.log("game", game, "executor", executor);

const scoreCall = (n) => viewSel("recordScore(uint256)") + BigInt(n).toString(16).padStart(64, "0");
const claimCall = () => viewSel("claimReward()");
const boomCall = () => viewSel("boom()");
const selOf = (sig) => B(viewSel(sig).slice(2));
async function nonceOf() {
  return BigInt(await rpc("eth_call", [{ to: account, data: viewSel("nonce()") }, "latest"]));
}
async function scoresOf() {
  const call = viewSel("scores(address)") + account.slice(2).toLowerCase().padStart(64, "0");
  return BigInt(await rpc("eth_call", [{ to: game, data: call }, "latest"]));
}
const topic = (sig) => hex(keccak(Buffer.from(sig, "ascii")));

// --- install executor module (nonce 0) ---
const installP = installPayload({
  chainId: CHAINID, account, moduleTypeId: 2, module: executor,
  initDataHash: keccak(Buffer.alloc(0)), nonce: 0, deadline,
});
const ins = assertion(owner, installP);
const installRcpt = await sendTx({
  from: RELAYER, to: account,
  data: installModuleData({
    moduleTypeId: 2, module: executor, initData: B(""), deadline,
    authData: ins.authData, clientDataJSON: ins.clientDataJSON, r: ins.r, s: ins.s,
  }),
});
assert.equal(installRcpt.status, "0x1", "installModule");
assert.equal(await nonceOf(), 1n, "install consumes nonce");
console.log("install OK");

// --- grant NONFINANCIAL recordScore scope (nonce 1) ---
const now = Math.floor(Date.now() / 1000);
const FEE_LIMIT = 500_000_000_000_000_000n; // 0.5 ETH lifetime session fees
const BATCH_CAP = 50_000_000_000_000_000n; // 0.05 ETH per-batch cap (generous; payload-bound)
const scope = {
  sessionX: B(session.x), sessionY: B(session.y),
  kind: 1, target: game,
  selector: selOf("recordScore(uint256)"),
  token: "0x0000000000000000000000000000000000000000",
  to: "0x0000000000000000000000000000000000000000",
  nftId: 0, validUntil: now + 7 * 86400, salt: crypto.randomBytes(32),
};
const pid = permissionId({ chainId: CHAINID, account, scope });
const grantP = grantPayload({
  chainId: CHAINID, account, permissionId: pid, scope, perTxCap: 0, totalLimit: 0,
  feeLimit: FEE_LIMIT, validAfter: now - 60, nonce: 1, deadline,
});
const g = assertion(owner, grantP);
const grantRcpt = await sendTx({
  from: RELAYER, to: account,
  data: grantPermissionData({
    grant: {
      permissionId: pid, sessionX: scope.sessionX, sessionY: scope.sessionY, kind: scope.kind,
      target: scope.target, selector: scope.selector, token: scope.token, to: scope.to,
      perTxCap: 0n, totalLimit: 0n, feeLimit: FEE_LIMIT, nftId: 0n, validAfter: now - 60, validUntil: scope.validUntil,
      salt: scope.salt, deadline,
    },
    authData: g.authData, clientDataJSON: g.clientDataJSON, r: g.r, s: g.s,
  }),
});
assert.equal(grantRcpt.status, "0x1", "grantPermission");
assert.equal(await nonceOf(), 2n, "grant consumes nonce");
console.log("grant OK pid", hex(pid));

// --- owner batch: [recordScore(3), claimReward()] (nonce 2) ---
const oTargets = [game, game];
const oValues = [0n, 0n];
const oDatas = [B(scoreCall(3).slice(2)), B(claimCall().slice(2))];
const oOps = opsHash({ targets: oTargets, values: oValues, datas: oDatas });
const oPayload = batchOwnerPayload({
  chainId: CHAINID, account, nonce: 2, opsHash: oOps, deadline, feePolicyVersion: 1, maxTotalFee: BATCH_CAP,
});
const o = assertion(owner, oPayload);
const draftOwner = executeBatchV4Data({
  targets: oTargets, values: oValues, datas: oDatas, deadline, feePolicyVersion: 1,
  maxTotalFee: BATCH_CAP, networkFee: 0n,
  authData: o.authData, clientDataJSON: o.clientDataJSON, r: o.r, s: o.s,
});
const oFee = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: account, data: draftOwner }])) * GAS_PRICE;
const factoryBefore = BigInt(await rpc("eth_getBalance", [factory, "latest"]));
const ownerBatchRcpt = await sendTx({
  from: RELAYER, to: account,
  data: executeBatchV4Data({
    targets: oTargets, values: oValues, datas: oDatas, deadline, feePolicyVersion: 1,
    maxTotalFee: BATCH_CAP, networkFee: oFee,
    authData: o.authData, clientDataJSON: o.clientDataJSON, r: o.r, s: o.s,
  }),
});
assert.equal(ownerBatchRcpt.status, "0x1", "owner batch: " + JSON.stringify(ownerBatchRcpt).slice(0, 300));
const batchTopic = topic("BatchExecuted(uint64,uint256,uint256,uint256)");
const opTopic = topic("BatchOpExecuted(uint64,uint256,address,uint256)");
assert.ok(ownerBatchRcpt.logs.some((l) => l.topics[0].toLowerCase() === batchTopic.toLowerCase()), "BatchExecuted logged");
assert.equal(ownerBatchRcpt.logs.filter((l) => l.topics[0].toLowerCase() === opTopic.toLowerCase()).length, 2, "2x BatchOpExecuted");
assert.equal(await scoresOf(), 4n, "3 + 1 reward");
assert.equal(await nonceOf(), 3n, "one nonce per batch");
assert.ok(BigInt(await rpc("eth_getBalance", [factory, "latest"])) > factoryBefore, "protocol fee to vault");
console.log("owner batch OK");

// --- session batch via executor: [recordScore(5), recordScore(7)], seq 0 ---
const sTargets = [game, game];
const sValues = [0n, 0n];
const sDatas = [B(scoreCall(5).slice(2)), B(scoreCall(7).slice(2))];
const sOps = opsHash({ targets: sTargets, values: sValues, datas: sDatas });
const sPayload = batchSessionPayload({
  chainId: CHAINID, account, permissionId: pid, seq: 0, opsHash: sOps,
  deadline, feePolicyVersion: 1, maxTotalFee: BATCH_CAP,
});
const se = assertion(session, sPayload);
const sInner = batchSessionInner({
  permissionId: pid, targets: sTargets, values: sValues, datas: sDatas,
  deadline, seq: 0, feePolicyVersion: 1, maxTotalFee: BATCH_CAP, networkFee: 0n,
  feeRecipient: RELAYER, authData: se.authData, clientDataJSON: se.clientDataJSON, r: se.r, s: se.s,
});
const draftInner = sInner; // estimate through the executor (module gate + batch path)
const sFee = BigInt(await rpc("eth_estimateGas", [{
  from: RELAYER, to: executor,
  data: executeViaPermissionV2Data({ account, mode: "0x0100000000000000000000000000000000000000000000000000000000000000", execCalldata: draftInner }),
}])) * GAS_PRICE;
const sInnerPaid = batchSessionInner({
  permissionId: pid, targets: sTargets, values: sValues, datas: sDatas,
  deadline, seq: 0, feePolicyVersion: 1, maxTotalFee: BATCH_CAP, networkFee: sFee,
  feeRecipient: RELAYER, authData: se.authData, clientDataJSON: se.clientDataJSON, r: se.r, s: se.s,
});
const MODE_BATCH = "0x0100000000000000000000000000000000000000000000000000000000000000";
const sessionBatchRcpt = await sendTx({
  from: RELAYER, to: executor,
  data: executeViaPermissionV2Data({ account, mode: MODE_BATCH, execCalldata: sInnerPaid }),
});
assert.equal(sessionBatchRcpt.status, "0x1", "session batch: " + JSON.stringify(sessionBatchRcpt).slice(0, 300));
const permBatchTopic = topic("PermissionBatchExecuted(bytes32,uint64,uint256,uint256,uint256)");
assert.ok(sessionBatchRcpt.logs.some((l) => l.topics[0].toLowerCase() === permBatchTopic.toLowerCase()), "PermissionBatchExecuted logged");
assert.equal(await scoresOf(), 16n, "4 + 5 + 7");
console.log("session batch OK");
// replay same seq reverts
const replayRcpt = await sendTx({
  from: RELAYER, to: executor,
  data: executeViaPermissionV2Data({ account, mode: MODE_BATCH, execCalldata: sInnerPaid }),
});
assert.equal(replayRcpt.status, "0x0", "seq replay reverts");
console.log("seq replay rejected OK");

// --- atomicity: owner batch with a reverting second op reverts everything ---
const aTargets = [game, game];
const aValues = [0n, 0n];
const aDatas = [B(scoreCall(1).slice(2)), B(boomCall().slice(2))];
const aOps = opsHash({ targets: aTargets, values: aValues, datas: aDatas });
const aPayload = batchOwnerPayload({
  chainId: CHAINID, account, nonce: 3, opsHash: aOps, deadline, feePolicyVersion: 1, maxTotalFee: BATCH_CAP,
});
const ab = assertion(owner, aPayload);
const atomicRcpt = await sendTx({
  from: RELAYER, to: account,
  data: executeBatchV4Data({
    targets: aTargets, values: aValues, datas: aDatas, deadline, feePolicyVersion: 1,
    maxTotalFee: BATCH_CAP, networkFee: oFee,
    authData: ab.authData, clientDataJSON: ab.clientDataJSON, r: ab.r, s: ab.s,
  }),
});
assert.equal(atomicRcpt.status, "0x0", "atomic batch reverts");
assert.equal(await scoresOf(), 16n, "no partial state");
assert.equal(await nonceOf(), 3n, "nonce unchanged");
console.log("atomicity OK");

// --- fee cap: attested total above the signed cap reverts ---
const tinyPayload = batchOwnerPayload({
  chainId: CHAINID, account, nonce: 3, opsHash: oOps, deadline, feePolicyVersion: 1, maxTotalFee: 1n,
});
const tc = assertion(owner, tinyPayload);
const capRcpt = await sendTx({
  from: RELAYER, to: account,
  data: executeBatchV4Data({
    targets: oTargets, values: oValues, datas: oDatas, deadline, feePolicyVersion: 1,
    maxTotalFee: 1n, networkFee: oFee,
    authData: tc.authData, clientDataJSON: tc.clientDataJSON, r: tc.r, s: tc.s,
  }),
});
assert.equal(capRcpt.status, "0x0", "under-cap batch reverts");
console.log("fee-cap OK");

// --- scope per-op: session batch mixing claimReward into a recordScore grant reverts,
// then seq-1 recovery proves the failed batch consumed nothing ---
const mTargets = [game, game];
const mValues = [0n, 0n];
const mDatas = [B(scoreCall(1).slice(2)), B(claimCall().slice(2))];
const mOps = opsHash({ targets: mTargets, values: mValues, datas: mDatas });
const mPayload = batchSessionPayload({
  chainId: CHAINID, account, permissionId: pid, seq: 1, opsHash: mOps,
  deadline, feePolicyVersion: 1, maxTotalFee: BATCH_CAP,
});
const mm = assertion(session, mPayload);
const mixedRcpt = await sendTx({
  from: RELAYER, to: executor,
  data: executeViaPermissionV2Data({
    account, mode: MODE_BATCH,
    execCalldata: batchSessionInner({
      permissionId: pid, targets: mTargets, values: mValues, datas: mDatas,
      deadline, seq: 1, feePolicyVersion: 1, maxTotalFee: BATCH_CAP, networkFee: sFee,
      feeRecipient: RELAYER, authData: mm.authData, clientDataJSON: mm.clientDataJSON, r: mm.r, s: mm.s,
    }),
  }),
});
assert.equal(mixedRcpt.status, "0x0", "mixed-scope batch reverts");
const rTargets = [game];
const rValues = [0n];
const rDatas = [B(scoreCall(1).slice(2))];
const rOps = opsHash({ targets: rTargets, values: rValues, datas: rDatas });
const rPayload = batchSessionPayload({
  chainId: CHAINID, account, permissionId: pid, seq: 1, opsHash: rOps,
  deadline, feePolicyVersion: 1, maxTotalFee: BATCH_CAP,
});
const rr = assertion(session, rPayload);
const recoverRcpt = await sendTx({
  from: RELAYER, to: executor,
  data: executeViaPermissionV2Data({
    account, mode: MODE_BATCH,
    execCalldata: batchSessionInner({
      permissionId: pid, targets: rTargets, values: rValues, datas: rDatas,
      deadline, seq: 1, feePolicyVersion: 1, maxTotalFee: BATCH_CAP, networkFee: sFee,
      feeRecipient: RELAYER, authData: rr.authData, clientDataJSON: rr.clientDataJSON, r: rr.r, s: rr.s,
    }),
  }),
});
assert.equal(recoverRcpt.status, "0x1", "seq-1 recovery succeeds");
assert.equal(await scoresOf(), 17n, "16 + 1 recovery");
console.log("scope-per-op + recovery OK — all V4 batch anvil assertions passed");
