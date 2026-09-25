// Task 009 acceptance (V3): PeridotWallet topup (deposit-only) + backend-gated,
// RP-ID-bound initialize + capped sponsored withdraw via the adapter, against the
// local validator (test backend build).
// Mock API covers identity/credentials only; chain reads go direct.
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PeridotWallet } from "../dist/esm/index.js";
import { SolanaAdapter, SolanaRpc, b64url, buildWebAuthnMessage, buildWithdrawPayloadV3 } from "@peridotvault/pid-solana";
import { pidToSeed32 } from "@peridotvault/pid-core";
const RP_ID_HASH = crypto.createHash("sha256").update("peridot-id.example").digest();
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
// Canonical revenue vault (must match the program's PID_TREASURY build const).
const TREASURY = new PublicKey("J8HubZoRgyr4z29Rv97zXdEzWqMJQz69LFvWa82m25s9");
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const PID = "ifal@pid";
function compressedPub(pub){const der=pub.export({format:"der",type:"spki"});const raw=der.subarray(der.length-65);const X=raw.subarray(1,33);return Buffer.concat([Buffer.from([(raw[64]&1)?0x03:0x02]),X]);}
const passkey = crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const AUTHORITY_B64 = compressedPub(passkey.publicKey).toString("base64url");
const AUTHORITY_COMP = compressedPub(passkey.publicKey);
const backend = Keypair.fromSecretKey(Buffer.from([2,165,58,5,85,113,187,187,189,165,0,247,194,28,78,38,100,30,150,157,210,65,241,136,120,108,19,175,51,247,44,88,68,27,157,74,181,156,0,3,4,104,44,101,23,145,208,210,131,227,116,208,145,70,66,152,114,42,243,151,173,78,79,158]));
const feePayer = Keypair.generate();
const PROGRAM = new PublicKey("CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT");
const [PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("peridot_id"), Buffer.from("account"), Buffer.from(pidToSeed32("ifal@pid"))],
  PROGRAM,
);
const PDA_B58 = PDA.toBase58();
const CHAIN_VIEW = {
  id: "chain-sol",
  namespace: "solana",
  reference: "ref",
  name: "solana-devnet",
  nativeSymbol: "SOL",
  decimals: 9,
  rpcUrls: ["http://127.0.0.1:8899"],
  explorerUrl: null,
  logoUrl: null,
  isTestnet: true,
  isActive: true,
  contracts: [{ id: "k1", chainId: "chain-sol", type: "program", address: PROGRAM.toBase58(), versionLabel: "v1", deployTxHash: null, isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
};
// mock API: identity + chain rows + credentials endpoints
const mockApi = {
  async get(path){
    if (path === "/v1/identity/me") return { ok: true, data: { pid: PID } };
    if (path === "/v1/account") return { ok: true, data: [{ id: "c1", pid: PID, chainId: "chain-sol", chainNamespace: "solana", chainReference: "ref", address: PDA_B58, accountType: "smart_account", status: "active", createdAt: new Date().toISOString() }] };
    if (path === "/v1/credentials") return { ok: true, data: [{ id: "a1", type: "secp256r1", credentialId: "cred", publicKey: AUTHORITY_B64, createdAt: new Date().toISOString(), lastUsedAt: null }] };
    if (path === "/v1/chains") return { ok: true, data: [CHAIN_VIEW] };
    return { ok: true, data: {} };
  },
  async post(){ return { ok: true, data: {} }; },
};
// mock passkey signer (V3: authenticatorData carries the RP-ID hash + UV flag)
const signer = { async sign(challenge){ const cj=Buffer.from(JSON.stringify({type:"webauthn.get",challenge:b64url(challenge),origin:"x"})); const ad=Buffer.concat([RP_ID_HASH,Buffer.from([0x05,0,0,0,1])]); const md=await buildWebAuthnMessage(ad,cj); let s=crypto.sign("sha256",md,{key:passkey.privateKey,dsaEncoding:"ieee-p1363"}); const r=BigInt("0x"+s.subarray(0,32).toString("hex"));let ss=BigInt("0x"+s.subarray(32).toString("hex"));if(ss>N/2n)ss=N-ss; return {credentialId:"cred",signature:Buffer.concat([Buffer.from(r.toString(16).padStart(64,"0"),"hex"),Buffer.from(ss.toString(16).padStart(64,"0"),"hex")]),authenticatorData:ad,clientDataJSON:cj}; } };
const storeMap = new Map([["peridot.feePayer.ed25519", Buffer.from(feePayer.secretKey).toString("hex")]]);
const wallet = new PeridotWallet(mockApi, { passkeySigner: signer, feePayerStore: { get: async(k)=>storeMap.get(k) ?? null, set: async(k,v)=>storeMap.set(k,v) } });
const adapter = new SolanaAdapter(new SolanaRpc("http://127.0.0.1:8899"));
await conn.confirmTransaction(await conn.requestAirdrop(feePayer.publicKey, 10*LAMPORTS_PER_SOL), "confirmed");
await conn.confirmTransaction(await conn.requestAirdrop(backend.publicKey, 10*LAMPORTS_PER_SOL), "confirmed");
const dest = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(dest.publicKey, 2*LAMPORTS_PER_SOL), "confirmed");
const me = await wallet.me();
assert.equal(me[0].id, "c1");
// backend-gated, passkey-signed V3 initialize (no squat without the key + backend)
const initSig = await adapter.initialize(PID, AUTHORITY_COMP, RP_ID_HASH, backend, signer);
await conn.confirmTransaction(initSig, "confirmed");
assert.equal(await adapter.isInitialized(PID), true, "initialized");
// topup is deposit-only now (creation is the activate flow)
const t = await wallet.topup({ amount: "10000000", asset: "SOL" });
await conn.confirmTransaction(t.signature, "confirmed");
console.log("topup OK; balance:", await wallet.getBalance());
// sponsored withdraw V3 via the adapter (op-tagged, account-bound, policy-only)
const nonce = await adapter.getNonce(PID);
const expiry = Math.floor(Date.now() / 1000) + 300;
const fee = 100_000n;
const networkFee = 100_000n;
const payload = await buildWithdrawPayloadV3(pidToSeed32(PID), nonce, 5_000_000n, dest.publicKey, expiry, 1);
const assertion = await signer.sign(payload);
const wSig = await adapter.sponsoredWithdrawSolV3(PID, AUTHORITY_COMP, dest.publicKey, 5_000_000n, 1, networkFee, nonce, expiry, assertion, backend, TREASURY);
await conn.confirmTransaction(wSig, "confirmed");
const st = await adapter.getStatus(wSig);
assert.equal(st.confirmed, true);
assert.equal(await conn.getBalance(dest.publicKey), 2 * LAMPORTS_PER_SOL + 5_000_000, "dest received amount");
console.log("withdraw OK; status:", JSON.stringify(st));
console.log("SDK WALLET E2E OK");
