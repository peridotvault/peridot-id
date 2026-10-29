// V4 anvil loop test (ANT-863 B2): self-contained calldata + real P-256
// signatures → live contracts. Migrated from the retired V3 loop: V3
// `deployAndInit` / `execute` are hard-closed on-chain (`V3Deprecated`), so
// the loop now drives the fee-capped V4 paths and asserts the V3 selectors
// revert.
//
// Proves the full off-chain → on-chain loop independent of forge and of
// packages/* (ANT-201 owns the SDK builders; this script duplicates the V4
// encodings it needs via `cast`, field-for-field with the contracts):
// P-256 signs the domain-free V4 activation/execute payloads, raw RPC submits
// to anvil, and the script asserts account state (initialized, authority,
// factory vault link) plus exact wei movements (relayerFee → submitter,
// protocolFee → factory). The V4 payload binds maxTotalFee (not the attested
// fee), so the estimate → attest flow signs once with a generous cap and
// rebuilds calldata with the attested fee — no re-signing.
//
// Requires: forge-built artifacts (`forge build` in contracts/evm),
// python `ecdsa` on PYTHONPATH, `cast` on PATH, and a running anvil:
//   anvil &
//   node contracts/evm/test/anvil-v4-e2e.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert, genKey, makeRpc, pidToSalt32, keccak, AUTH_PREFIX,
  actPayloadV4, exePayloadV4, exePayloadV3, assertion,
  deployAndInitV4Data, executeV4Data, executeData, deployAndInitData, viewSel,
} from "./e2e-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVM_ROOT = join(HERE, "..");
const ANVIL = "http://127.0.0.1:8545";
// Admin of the fresh factory (holds no creation privilege — creation is
// permissionless since ANT-610; admin only drains revenue via withdrawRevenue).
const RELAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Independent submitter (anvil account #1): proves AC-E1 — anyone with a valid
// user authorization can deploy, not just the factory admin.
const SUBMITTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const GAS_PRICE = 10_000_000_000n; // 10 gwei — explicit price for the sanity bound
const GAS_PRICE_HEX = "0x" + GAS_PRICE.toString(16);
// Even-length hex: anvil rejects odd-length `value` quantities.
const weiHex = (v) => { const h = v.toString(16); return "0x" + (h.length % 2 ? "0" + h : h); };
const PROTOCOL_FEE_OF = (net) => net / 2n; // policy v1 = 5000 bps
const CHAINID = 31337;

const { rpc, receiptOf } = await makeRpc(ANVIL);

// sendTx: receipt-status assertion helper (reverted txs surface as status 0x0).
async function sendTx(tx) {
  const hash = await rpc("eth_sendTransaction", [{ gasPrice: GAS_PRICE_HEX, ...tx }]);
  return receiptOf(hash);
}

// --- deploy impl + factory via anvil's unlocked dev account ---
function deployBytecode(artifact, argsHex = "") {
  const j = JSON.parse(readFileSync(join(EVM_ROOT, "out", artifact + ".json"), "utf8"));
  return j.bytecode.object + argsHex;
}
const padAddr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const implDeploy = await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotAccount.sol/PeridotAccount") }]);
const impl = (await receiptOf(implDeploy)).contractAddress;
const factoryDeploy = await rpc("eth_sendTransaction", [{
  from: RELAYER,
  // constructor(implementation, admins[]) — single admin = RELAYER; dynamic array encoding.
  // No relayer allowlist since ANT-610: creation is permissionless.
  data: deployBytecode("PeridotFactory.sol/PeridotFactory",
    padAddr(impl) +
    "0000000000000000000000000000000000000000000000000000000000000040" + // admins offset
    "0000000000000000000000000000000000000000000000000000000000000001" + // length 1
    padAddr(RELAYER)),
}]);
const factory = (await receiptOf(factoryDeploy)).contractAddress;
console.log("impl", impl, "factory", factory);

// Fund the independent submitter (gas money only — the fee split pays it back).
await rpc("eth_sendTransaction", [{ from: RELAYER, to: SUBMITTER, value: weiHex(10n ** 18n) }]);

// --- P-256 keypair (node:crypto cannot sign prehashed digests; python ecdsa can) ---
const keyJson = genKey();
const x = Buffer.from(keyJson.x, "hex");
const y = Buffer.from(keyJson.y, "hex");

// --- predict the counterfactual (fund after attesting, below) ---
const salt = pidToSalt32("e2e-v4@pid");
const saltHex = "0x" + Buffer.from(salt).toString("hex");
const predicted = await rpc("eth_call", [{ to: factory, data: viewSel("predict(bytes32)") + saltHex.slice(2).padStart(64, "0") }, "latest"]);
const account = "0x" + predicted.slice(-40);

// --- activate via self-contained V4 calldata ---
// The V4 payload binds the user-approved maxTotalFee cap (not the attested
// fee), so: sign once with a generous cap, draft with a zero placeholder,
// estimate like the backend, rebuild with the attested fee — no re-signing.
const deadline = Math.floor(Date.now() / 1000) + 300;
const MAX_TOTAL_FEE = 100_000_000_000_000_000n; // 0.1 ether cap — covers any honest attestation
const actPayload = actPayloadV4({
  salt, x, y, feePolicyVersion: 1, maxTotalFee: MAX_TOTAL_FEE,
  deadline, chainId: CHAINID, factory,
});
const act = assertion(keyJson, actPayload);
const draftData = deployAndInitV4Data({
  salt, x, y, feePolicyVersion: 1, maxTotalFee: MAX_TOTAL_FEE, deadline, networkFee: 0n,
  authData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const estGas = BigInt(await rpc("eth_estimateGas", [{ from: SUBMITTER, to: factory, data: draftData }]));
const NETWORK_FEE = estGas * GAS_PRICE; // backend-style attestation: estimate × price
const PROTOCOL_FEE = PROTOCOL_FEE_OF(NETWORK_FEE);
assert.ok(NETWORK_FEE + PROTOCOL_FEE <= MAX_TOTAL_FEE, "attested total within the signed cap");
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: weiHex(NETWORK_FEE + PROTOCOL_FEE) }]);
// AC-E1: the deploy is submitted by the independent SUBMITTER, not the admin.
const data = deployAndInitV4Data({
  salt, x, y, feePolicyVersion: 1, maxTotalFee: MAX_TOTAL_FEE, deadline, networkFee: NETWORK_FEE,
  authData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const submitterBefore = BigInt(await rpc("eth_getBalance", [SUBMITTER, "latest"]));
const receipt = await sendTx({ from: SUBMITTER, to: factory, data });
assert.equal(receipt.status, "0x1", "deployAndInitV4 succeeded: " + JSON.stringify(receipt).slice(0, 200));
// Fee split follows the submitter: networkFee → SUBMITTER minus its own gas,
// protocolFee → factory vault.
const submitterAfter = BigInt(await rpc("eth_getBalance", [SUBMITTER, "latest"]));
const gasCost = BigInt(receipt.gasUsed) * GAS_PRICE;
assert.equal(submitterAfter - submitterBefore, NETWORK_FEE - gasCost, "networkFee reimbursed to the actual submitter");
assert.equal(BigInt(await rpc("eth_getBalance", [factory, "latest"])), PROTOCOL_FEE, "protocolFee landed in the factory vault");
const get = async (s) => rpc("eth_call", [{ to: account, data: viewSel(s) }, "latest"]);
assert.equal(BigInt(await get("initialized()")), 1n, "initialized");
assert.equal((await get("authorityX()")).toLowerCase(), "0x" + keyJson.x, "authorityX stored");
assert.equal((await get("authorityY()")).toLowerCase(), "0x" + keyJson.y, "authorityY stored");
assert.equal((await get("factory()")).toLowerCase(), "0x" + "00".repeat(12) + factory.slice(2).toLowerCase(), "canonical factory link");
assert.equal(BigInt(await rpc("eth_getBalance", [account, "latest"])), 0n, "account fully distributed");
console.log("activate OK", receipt.transactionHash);

// --- execute 0.5 ETH via self-contained V4 payload + revenue assertions ---
const dest = "0x0000000000000000000000000000000000001234";
const value = 500_000_000_000_000_000n;
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: weiHex(value + 50_000_000_000_000_000n) }]);
const nonce = 0;
const EXE_MAX = 50_000_000_000_000_000n; // 0.05 ether cap — covers any honest attestation
const exePayload = exePayloadV4({
  chainId: CHAINID, account, nonce, to: dest, value,
  dataHash: keccak(new Uint8Array(0)), deadline, feePolicyVersion: 1, maxTotalFee: EXE_MAX,
});
const exe = assertion(keyJson, exePayload);
// Post-ANT-206 the on-chain GasAnomaly bound measures the full execute
// frame (2x verify + call + payouts), so honest backend-style
// estimate x price attestation passes. Draft with a zero placeholder,
// estimate like the backend, rebuild with the attested fee (the V4 payload
// binds the cap only, so no re-signing is needed).
const draftExe = executeV4Data({
  to: dest, value, data: new Uint8Array(0), deadline, feePolicyVersion: 1,
  maxTotalFee: EXE_MAX, networkFee: 0n, authData: exe.authData, clientDataJSON: exe.clientDataJSON,
  r: exe.r, s: exe.s,
});
const exeEst = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: account, data: draftExe }]));
const EXE_FEE = exeEst * GAS_PRICE;
const EXE_PROTO = PROTOCOL_FEE_OF(EXE_FEE);
assert.ok(EXE_FEE + EXE_PROTO <= EXE_MAX, "attested total within the signed cap");
const exeData = executeV4Data({
  to: dest, value, data: new Uint8Array(0), deadline, feePolicyVersion: 1,
  maxTotalFee: EXE_MAX, networkFee: EXE_FEE, authData: exe.authData, clientDataJSON: exe.clientDataJSON,
  r: exe.r, s: exe.s,
});
const factoryBalBefore = BigInt(await rpc("eth_getBalance", [factory, "latest"]));
const exeReceipt = await sendTx({ from: RELAYER, to: account, data: exeData });
assert.equal(exeReceipt.status, "0x1", "executeV4 succeeded");
assert.equal(BigInt(await rpc("eth_getBalance", [dest, "latest"])), value, "dest received value");
assert.equal(
  BigInt(await rpc("eth_getBalance", [account, "latest"])),
  50_000_000_000_000_000n - EXE_FEE - EXE_PROTO,
  "account kept only the prefund remainder",
);
assert.equal(
  BigInt(await rpc("eth_getBalance", [factory, "latest"])) - factoryBalBefore,
  EXE_PROTO,
  "factory accumulated the execute protocol fee",
);
console.log("execute OK", exeReceipt.transactionHash);

// --- over-cap V4 execute reverts (FeeExceedsMax, nothing moves) ---
const tinyExe = exePayloadV4({
  chainId: CHAINID, account, nonce: 1, to: dest, value: 0n,
  dataHash: keccak(new Uint8Array(0)), deadline, feePolicyVersion: 1, maxTotalFee: 1n,
});
const te = assertion(keyJson, tinyExe);
const tinyRcpt = await sendTx({
  from: RELAYER, to: account,
  data: executeV4Data({
    to: dest, value: 0n, data: new Uint8Array(0), deadline, feePolicyVersion: 1,
    maxTotalFee: 1n, networkFee: EXE_FEE, authData: te.authData, clientDataJSON: te.clientDataJSON,
    r: te.r, s: te.s,
  }),
});
assert.equal(tinyRcpt.status, "0x0", "under-cap executeV4 reverts");
console.log("maxTotalFee rejected OK");

// --- ANT-863 B2: the retired V3 selectors revert on-chain ---
// A V3 factory call must not settle. The assertion content is irrelevant —
// the V3Deprecated gate fires before any signature validation — so the V4
// assertion above is reused as opaque bytes.
const v3Salt = pidToSalt32("e2e-v3-dead@pid");
const v3act = act;
// NOTE: deployAndInitData encodes the V3 factory selector (verified below to
// revert) — the payload shape is irrelevant because the gate fires first.
const v3deployData = deployAndInitData({
  salt: v3Salt, x, y, feePolicyVersion: 1, deadline, networkFee: NETWORK_FEE,
  authData: v3act.authData, clientDataJSON: v3act.clientDataJSON, r: v3act.r, s: v3act.s,
});
const v3deployRcpt = await sendTx({ from: SUBMITTER, to: factory, data: v3deployData });
assert.equal(v3deployRcpt.status, "0x0", "V3 deployAndInit reverts (V3Deprecated)");
// A V3-signed execute (correct key, fresh nonce shape) must not settle either.
const v3exePayload = exePayloadV3({
  chainId: CHAINID, account, nonce: 1, to: dest, value: 0n,
  dataHash: keccak(new Uint8Array(0)), deadline, feePolicyVersion: 1,
});
const v3exe = assertion(keyJson, v3exePayload);
const v3exeRcpt = await sendTx({
  from: RELAYER, to: account,
  data: executeData({
    to: dest, value: 0n, data: new Uint8Array(0), deadline, feePolicyVersion: 1,
    networkFee: 0n, authData: v3exe.authData, clientDataJSON: v3exe.clientDataJSON,
    r: v3exe.r, s: v3exe.s,
  }),
});
assert.equal(v3exeRcpt.status, "0x0", "V3 execute reverts (V3Deprecated)");
console.log("V3 hard-close OK");

// --- admin withdraws revenue (both protocol fees) ---
const TOTAL_PROTO = PROTOCOL_FEE + EXE_PROTO;
const wdData = viewSel("withdrawRevenue(address,uint256)") + dest.slice(2).padStart(64, "0") + TOTAL_PROTO.toString(16).padStart(64, "0");
const wdHash = await rpc("eth_sendTransaction", [{ from: RELAYER, to: factory, data: wdData }]);
const wdReceipt = await receiptOf(wdHash);
assert.equal(wdReceipt.status, "0x1", "withdrawRevenue succeeded");
assert.equal(BigInt(await rpc("eth_getBalance", [factory, "latest"])), 0n, "vault drained");
console.log("EVM V4 ANVIL E2E OK");
console.log("authenticator prefix (neutral, never verified):", "0x" + AUTH_PREFIX.toString("hex").slice(0, 16) + "…");
