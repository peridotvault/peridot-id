// V3 anvil loop test: self-contained calldata + real P-256 signatures → live contracts.
//
// Proves the full off-chain → on-chain loop independent of forge and of
// packages/* (ANT-201 owns the SDK builders; this script duplicates the two V3
// encodings it needs via `cast`, field-for-field with the contracts):
// P-256 signs the domain-free V3 activation/execute payloads, raw RPC submits
// to anvil, and the script asserts account state (initialized, authority,
// factory vault link) plus exact wei movements (relayerFee → submitter,
// protocolFee → factory).
//
// Requires: forge-built artifacts (`forge build` in contracts/evm),
// python `ecdsa` on PYTHONPATH, `cast` on PATH, and a running anvil:
//   anvil &
//   node contracts/evm/test/anvil-v3-e2e.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assert, genKey, makeRpc, pidToSalt32, pidToBoundSalt, keccak, AUTH_PREFIX,
  actPayloadV3, exePayloadV3, assertion,
  deployAndInitData, executeData, predictBoundData, viewSel,
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
// B1 (ANT-866): salt is PID-KEY BOUND — only this key can claim the address.
const pidHash = pidToSalt32("e2e-v3@pid");
const salt = pidToBoundSalt("e2e-v3@pid", x, y);
const predicted = await rpc("eth_call", [{ to: factory, data: predictBoundData({ pidHash, x, y }) }, "latest"]);
const account = "0x" + predicted.slice(-40);

// --- activate via self-contained calldata ---
// The V3 payload binds policy only (domain-free: no rpIdHash), so attestation
// can be refreshed without re-signing: build with a zero placeholder,
// estimate like the backend, rebuild.
const deadline = Math.floor(Date.now() / 1000) + 300;
const actPayload = actPayloadV3({
  salt, x, y, feePolicyVersion: 1,
  deadline, chainId: CHAINID, factory,
});
const act = assertion(keyJson, actPayload);
const draftData = deployAndInitData({
  pidHash, x, y, feePolicyVersion: 1, deadline, networkFee: 0n,
  authData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const estGas = BigInt(await rpc("eth_estimateGas", [{ from: SUBMITTER, to: factory, data: draftData }]));
const NETWORK_FEE = estGas * GAS_PRICE; // backend-style attestation: estimate × price
const PROTOCOL_FEE = PROTOCOL_FEE_OF(NETWORK_FEE);
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: weiHex(NETWORK_FEE + PROTOCOL_FEE) }]);
// AC-E1: the deploy is submitted by the independent SUBMITTER, not the admin.
const data = deployAndInitData({
  pidHash, x, y, feePolicyVersion: 1, deadline, networkFee: NETWORK_FEE,
  authData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const submitterBefore = BigInt(await rpc("eth_getBalance", [SUBMITTER, "latest"]));
const hash = await rpc("eth_sendTransaction", [{ from: SUBMITTER, to: factory, data, gasPrice: GAS_PRICE_HEX }]);
const receipt = await receiptOf(hash);
assert.equal(receipt.status, "0x1", "deployAndInit succeeded: " + JSON.stringify(receipt).slice(0, 200));
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
console.log("activate OK", hash);

// --- execute 0.5 ETH via self-contained payload + revenue assertions ---
const dest = "0x0000000000000000000000000000000000001234";
const value = 500_000_000_000_000_000n;
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: weiHex(value + 50_000_000_000_000_000n) }]);
const nonce = 0;
const exePayload = exePayloadV3({
  chainId: CHAINID, account, nonce, to: dest, value,
  dataHash: keccak(new Uint8Array(0)), deadline, feePolicyVersion: 1,
});
const exe = assertion(keyJson, exePayload);
// Post-ANT-206 the on-chain GasAnomaly bound measures the full execute
// frame (2x verify + call + payouts), so honest backend-style
// estimate x price attestation passes. Build with a zero placeholder,
// estimate like the backend, rebuild with the attested fee (the V3 payload
// binds policy only, so no re-signing is needed).
const draftExe = executeData({
  to: dest, value, data: new Uint8Array(0), deadline, feePolicyVersion: 1,
  networkFee: 0n, authData: exe.authData, clientDataJSON: exe.clientDataJSON,
  r: exe.r, s: exe.s,
});
const exeEst = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: account, data: draftExe }]));
const EXE_FEE = exeEst * GAS_PRICE;
const EXE_PROTO = PROTOCOL_FEE_OF(EXE_FEE);
const exeData = executeData({
  to: dest, value, data: new Uint8Array(0), deadline, feePolicyVersion: 1,
  networkFee: EXE_FEE, authData: exe.authData, clientDataJSON: exe.clientDataJSON,
  r: exe.r, s: exe.s,
});
const factoryBalBefore = BigInt(await rpc("eth_getBalance", [factory, "latest"]));
const exeHash = await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, data: exeData, gasPrice: GAS_PRICE_HEX }]);
const exeReceipt = await receiptOf(exeHash);
assert.equal(exeReceipt.status, "0x1", "execute succeeded");
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
console.log("execute OK", exeHash);

// --- admin withdraws revenue (both protocol fees) ---
const TOTAL_PROTO = PROTOCOL_FEE + EXE_PROTO;
const wdData = viewSel("withdrawRevenue(address,uint256)") + dest.slice(2).padStart(64, "0") + TOTAL_PROTO.toString(16).padStart(64, "0");
const wdHash = await rpc("eth_sendTransaction", [{ from: RELAYER, to: factory, data: wdData }]);
const wdReceipt = await receiptOf(wdHash);
assert.equal(wdReceipt.status, "0x1", "withdrawRevenue succeeded");
assert.equal(BigInt(await rpc("eth_getBalance", [factory, "latest"])), 0n, "vault drained");
console.log("EVM V3 ANVIL E2E OK");
console.log("authenticator prefix (neutral, never verified):", "0x" + AUTH_PREFIX.toString("hex").slice(0, 16) + "…");
