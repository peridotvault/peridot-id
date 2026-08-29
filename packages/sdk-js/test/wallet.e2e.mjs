// Task 009 acceptance: PeridotWallet topup + withdraw via a mock API + mock passkey signer.
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { PeridotWallet } from "@peridot/sdk-js";
import { b64url, buildWebAuthnMessage } from "@peridot/solana";
const N = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const ACCOUNT_ID = crypto.randomUUID();
function compressedPub(pub){const der=pub.export({format:"der",type:"spki"});const raw=der.subarray(der.length-65);const X=raw.subarray(1,33);return Buffer.concat([Buffer.from([(raw[64]&1)?0x03:0x02]),X]);}
const passkey = crypto.generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const AUTHORITY_B64 = compressedPub(passkey.publicKey).toString("base64url");
const feePayer = Keypair.generate();
// mock API: account + credentials endpoints
const mockApi = {
  async get(path){
    if (path === "/v1/accounts") return { ok: true, data: [{ id: ACCOUNT_ID, status: "active", version: 1, createdAt: new Date().toISOString(), chainAccounts: [{ id: "c1", chainNamespace: "solana", chainReference: "ref", address: "x", accountType: "smart_account", status: "active", createdAt: new Date().toISOString() }] }] };
    if (path === "/v1/credentials") return { ok: true, data: [{ id: "a1", type: "secp256r1", credentialId: "cred", publicKey: AUTHORITY_B64, createdAt: new Date().toISOString(), lastUsedAt: null }] };
    return { ok: true, data: {} };
  },
  async post(){ return { ok: true, data: {} }; },
};
// mock passkey signer
const signer = { async sign(challenge){ const cj=Buffer.from(JSON.stringify({type:"webauthn.get",challenge:b64url(challenge),origin:"x"})); const ad=Buffer.alloc(37);ad.writeUInt32BE(1,33); const md=await buildWebAuthnMessage(ad,cj); let s=crypto.sign("sha256",md,{key:passkey.privateKey,dsaEncoding:"ieee-p1363"}); const r=BigInt("0x"+s.subarray(0,32).toString("hex"));let ss=BigInt("0x"+s.subarray(32).toString("hex"));if(ss>N/2n)ss=N-ss; return {credentialId:"cred",signature:Buffer.concat([Buffer.from(r.toString(16).padStart(64,"0"),"hex"),Buffer.from(ss.toString(16).padStart(64,"0"),"hex")]),authenticatorData:ad,clientDataJSON:cj}; } };
const storeMap = new Map([["peridot.feePayer.ed25519", Buffer.from(feePayer.secretKey).toString("hex")]]);
const wallet = new PeridotWallet(mockApi, { solanaRpcUrl: "http://127.0.0.1:8899", passkeySigner: signer, feePayerStore: { get: async(k)=>storeMap.get(k) ?? null, set: async(k,v)=>storeMap.set(k,v) } });
await conn.confirmTransaction(await conn.requestAirdrop(feePayer.publicKey, 10*LAMPORTS_PER_SOL), "confirmed");
const dest = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(dest.publicKey, 2*LAMPORTS_PER_SOL), "confirmed");
const me = await wallet.me();
assert.equal(me.id, ACCOUNT_ID);
const t = await wallet.topup({ amount: "10000000", asset: "SOL" });
await conn.confirmTransaction(t.signature, "confirmed");
console.log("topup OK; balance:", await wallet.getBalance());
const w = await wallet.withdraw({ amount: "5000000", asset: "SOL", to: dest.publicKey.toBase58() });
await conn.confirmTransaction(w.signature, "confirmed");
const st = await wallet.getTransactionStatus(w.signature);
assert.equal(st.confirmed, true);
console.log("withdraw OK; status:", JSON.stringify(st));
console.log("SDK WALLET E2E OK");
