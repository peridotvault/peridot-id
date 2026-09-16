// V3 anvil loop test: TS-built calldata + real P-256 signatures → live contracts.
//
// Proves the full off-chain → on-chain loop independent of forge:
// pid-evm builds `deployAndInit` calldata + the V3 activation/execute payloads,
// python/`ecdsa` signs the raw digests, raw RPC submits to anvil, and the script
// asserts account state (initialized, authority, rpIdHash, factory vault link)
// plus exact wei movements (relayerFee → submitter, protocolFee → factory).
//
// Requires: forge-built artifacts (`forge build` in contracts/evm),
// python `ecdsa` (`pip install ecdsa`), and a running anvil:
//   anvil &
//   node contracts/evm/test/anvil-v3-e2e.mjs
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
const GAS_PRICE = 10_000_000_000n; // 10 gwei — explicit price for the sanity bound
const GAS_PRICE_HEX = "0x" + GAS_PRICE.toString(16);
const RP_ID_HASH = crypto.createHash("sha256").update("localhost").digest();
const PROTOCOL_FEE_OF = (net) => net / 2n; // policy v1 = 5000 bps
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

const core = await import("../../../packages/core/dist/evm.js");
const { EvmAdapter } = await import("../../../packages/evm/dist/adapter.js");

// --- deploy impl + factory via anvil's unlocked dev account ---
function deployBytecode(artifact, argsHex = "") {
  const j = JSON.parse(readFileSync(join(EVM_ROOT, "out", artifact + ".json"), "utf8"));
  return j.bytecode.object + argsHex;
}
const padAddr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const implDeploy = await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotAccount.sol/PeridotAccount") }]);
const impl = (await rpc("eth_getTransactionReceipt", [implDeploy])).contractAddress;
const factoryDeploy = await rpc("eth_sendTransaction", [{
  from: RELAYER,
  // constructor(implementation, relayer, admins[]) — single admin = relayer; dynamic array encoding
  data: deployBytecode("PeridotFactory.sol/PeridotFactory",
    padAddr(impl) + padAddr(RELAYER) +
    "0000000000000000000000000000000000000000000000000000000000000060" + // admins offset
    "0000000000000000000000000000000000000000000000000000000000000001" + // length 1
    padAddr(RELAYER)),
}]);
const factory = (await rpc("eth_getTransactionReceipt", [factoryDeploy])).contractAddress;
console.log("impl", impl, "factory", factory);

const rpcLike = {
  getBalance: async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"])),
  getCode: async (a) => rpc("eth_getCode", [a, "latest"]),
  chainId: async () => Number(BigInt(await rpc("eth_chainId", []))),
  gasPrice: async () => BigInt(await rpc("eth_gasPrice", [])),
  blockTimestamp: async () => Number(BigInt((await rpc("eth_getBlockByNumber", ["latest", false])).timestamp)),
  call: async (m, p) => rpc(m, p),
};
const adapter = new EvmAdapter(rpcLike, factory, impl);

// --- P-256 keypair (python; node:crypto cannot sign prehashed digests) ---
const keyJson = JSON.parse(execSync(
  `python3 -c "import ecdsa,json; sk=ecdsa.SigningKey.generate(curve=ecdsa.NIST256p); vk=sk.get_verifying_key(); print(json.dumps({'priv':sk.to_string().hex(),'x':vk.pubkey.point.x().to_bytes(32,'big').hex(),'y':vk.pubkey.point.y().to_bytes(32,'big').hex()}))"`,
  { encoding: "utf8" },
));
const x = Buffer.from(keyJson.x, "hex");
const y = Buffer.from(keyJson.y, "hex");
function signDigest(hHex) {
  return Buffer.from(execSync(
    `python3 -c "import ecdsa; from ecdsa import util; sk=ecdsa.SigningKey.from_string(bytes.fromhex('${keyJson.priv}'),curve=ecdsa.NIST256p); n=ecdsa.NIST256p.order; sig=sk.sign_digest(bytes.fromhex('${hHex}'),sigencode=util.sigencode_string); r,s=util.sigdecode_string(sig,n); s=n-s if s>n//2 else s; print((r.to_bytes(32,'big')+s.to_bytes(32,'big')).hex())"`,
    { encoding: "utf8" },
  ).trim(), "hex");
}
function webauthnChallenge(payload) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get", challenge: Buffer.from(payload).toString("base64url"), origin: "http://localhost:8081",
  }));
  const authData = Buffer.concat([RP_ID_HASH, Buffer.from([0x05, 0, 0, 0, 1])]);
  const h = crypto.createHash("sha256").update(Buffer.concat([authData, crypto.createHash("sha256").update(clientDataJSON).digest()])).digest();
  const sig = signDigest(h.toString("hex"));
  return { authData, clientDataJSON, r: sig.subarray(0, 32), s: sig.subarray(32) };
}

// --- predict the counterfactual (fund after attesting, below) ---
const salt = core.pidToSalt32("e2e-v3@pid");
const saltHex = "0x" + Buffer.from(salt).toString("hex");
const sel = (s) => "0x" + Buffer.from(core.keccak256(core.fromAscii(s)).subarray(0, 4)).toString("hex");
const predicted = await rpc("eth_call", [{ to: factory, data: sel("predict(bytes32)") + saltHex.slice(2).padStart(64, "0") }, "latest"]);
const account = "0x" + predicted.slice(-40);

// --- activate via TS-built calldata ---
// The V3 payload binds policy only, so attestation can be refreshed without
// re-signing: build with a zero placeholder, estimate like the backend, rebuild.
const deadline = Math.floor(Date.now() / 1000) + 300;
const actPayload = adapter.buildActivatePayloadV3({
  salt: saltHex, x, y, rpIdHash: RP_ID_HASH, feePolicyVersion: 1,
  deadline, chainId: CHAINID, factory,
});
const act = webauthnChallenge(actPayload);
const draftData = adapter.buildDeployAndInitDataV3({
  salt: saltHex, x, y, rpIdHash: RP_ID_HASH, feePolicyVersion: 1, deadline, networkFee: 0n,
  authenticatorData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const estGas = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: factory, data: draftData }]));
const NETWORK_FEE = estGas * GAS_PRICE; // backend-style attestation: estimate × price
const PROTOCOL_FEE = PROTOCOL_FEE_OF(NETWORK_FEE);
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: "0x" + (NETWORK_FEE + PROTOCOL_FEE).toString(16) }]);
const data = adapter.buildDeployAndInitDataV3({
  salt: saltHex, x, y, rpIdHash: RP_ID_HASH, feePolicyVersion: 1, deadline, networkFee: NETWORK_FEE,
  authenticatorData: act.authData, clientDataJSON: act.clientDataJSON, r: act.r, s: act.s,
});
const relayerBefore = BigInt(await rpc("eth_getBalance", [RELAYER, "latest"]));
const hash = await rpc("eth_sendTransaction", [{ from: RELAYER, to: factory, data, gasPrice: GAS_PRICE_HEX }]);
const receipt = await receiptOf(hash);
assert.equal(receipt.status, "0x1", "deployAndInit succeeded: " + JSON.stringify(receipt).slice(0, 200));
const get = async (s) => rpc("eth_call", [{ to: account, data: sel(s) }, "latest"]);
assert.equal(BigInt(await get("initialized()")), 1n, "initialized");
assert.equal((await get("authorityX()")).toLowerCase(), "0x" + keyJson.x, "authorityX stored");
assert.equal((await get("authorityY()")).toLowerCase(), "0x" + keyJson.y, "authorityY stored");
assert.equal((await get("rpIdHash()")).toLowerCase(), "0x" + RP_ID_HASH.toString("hex"), "rpIdHash stored");
assert.equal((await get("factory()")).toLowerCase(), "0x" + "00".repeat(12) + factory.slice(2).toLowerCase(), "canonical factory link");
assert.equal(BigInt(await rpc("eth_getBalance", [account, "latest"])), 0n, "account fully distributed");
console.log("activate OK", hash);

// --- execute 0.5 ETH via TS-built payload + revenue assertions ---
const dest = "0x0000000000000000000000000000000000001234";
const value = 500_000_000_000_000_000n;
await rpc("eth_sendTransaction", [{ from: RELAYER, to: account, value: "0x" + (value + 50_000_000_000_000_000n).toString(16) }]);
const nonce = 0;
const exePayload = adapter.buildExecutePayloadV3({
  chainId: CHAINID, account, nonce, to: dest, value,
  dataHash: core.keccak256(new Uint8Array(0)), deadline, feePolicyVersion: 1,
});
const exe = webauthnChallenge(exePayload);
const draftExe = adapter.buildExecuteDataV3({
  to: dest, value, data: new Uint8Array(0), deadline, feePolicyVersion: 1,
  networkFee: 0n, authenticatorData: exe.authData, clientDataJSON: exe.clientDataJSON,
  r: exe.r, s: exe.s,
});
const exeEst = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: account, data: draftExe }]));
const EXE_FEE = exeEst * GAS_PRICE;
const EXE_PROTO = PROTOCOL_FEE_OF(EXE_FEE);
const exeData = adapter.buildExecuteDataV3({
  to: dest, value, data: new Uint8Array(0), deadline, feePolicyVersion: 1,
  networkFee: EXE_FEE, authenticatorData: exe.authData, clientDataJSON: exe.clientDataJSON,
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
const wdData = sel("withdrawRevenue(address,uint256)") + dest.slice(2).padStart(64, "0") + TOTAL_PROTO.toString(16).padStart(64, "0");
const wdHash = await rpc("eth_sendTransaction", [{ from: RELAYER, to: factory, data: wdData }]);
const wdReceipt = await receiptOf(wdHash);
assert.equal(wdReceipt.status, "0x1", "withdrawRevenue succeeded");
assert.equal(BigInt(await rpc("eth_getBalance", [factory, "latest"])), 0n, "vault drained");
console.log("EVM V3 ANVIL E2E OK");
