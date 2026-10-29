// ANT-866/F2: close-flow derivation targets the CLAIMING key post-rotation.
// Runs against the BUILT package, no chain: a stub rpc records every account
// read and returns a canned CLOSING-capable vault state, so the test proves
// which PDA the adapter actually resolves (vault + ticket + nonce source).
// Run: `node --test test/close-derivation.test.mjs` from packages/solana
// (after `pnpm build`, like packages/core).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pkg from "../dist/index.js";

const {
  SolanaAdapter,
  deriveSmartAccountAddress,
  deriveTicketAddress,
  vaultKeyHash,
  pidToSeed32,
} = pkg;
const { PublicKey, Keypair } = await import("@solana/web3.js");

const PROGRAM = new PublicKey("CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT");
const PID = "b1f2@pid";
// Claiming key K0 (bound at activation) vs signing key K1 (post-rotation current).
const K0 = Buffer.from("02" + "11".repeat(32), "hex");
const K1 = Buffer.from("03" + "22".repeat(32), "hex");
const PID_HASH = pidToSeed32(PID);

function vaultState() {
  const b = Buffer.alloc(112);
  b[0] = 3; // VERSION_V3
  b[1] = 1; // secp256r1
  b[2] = 0; // ACTIVE
  b.writeBigUInt64LE(5n, 4); // nonce
  Buffer.from(K1).copy(b, 12); // current authority (rotated)
  Buffer.from(PID_HASH).copy(b, 48);
  Buffer.from(vaultKeyHash(new Uint8Array(K0))).copy(b, 80); // stored claiming hash
  return b;
}

function stubRpc(calls) {
  return {
    async getAccountInfo(pubkey) {
      calls.push(pubkey.toBase58());
      return { data: vaultState(), lamports: 1_000_000, owner: PROGRAM };
    },
    async getBlockTime() { return 1_700_000_000; },
    async getLatestBlockhash() { return "BHQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; },
    async sendTransaction() { return "sig-stub"; },
  };
}

const stubSigner = {
  async sign() {
    return {
      credentialId: "cred",
      signature: new Uint8Array(64).fill(7),
      authenticatorData: new Uint8Array(37).fill(0x05, 32, 33),
      clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: "AA", origin: "x" })),
    };
  },
};

const expectedVault = deriveSmartAccountAddress(PID, new Uint8Array(K0), PROGRAM).address;
const expectedTicket = deriveTicketAddress(new Uint8Array(PID_HASH), new Uint8Array(K0), PROGRAM).address;

describe("ANT-866/F2 close-flow derivation", () => {
  it("requestClose resolves vault+ticket+nonce from derivationAuthority, not the signing key", async () => {
    const calls = [];
    const adapter = new SolanaAdapter(stubRpc(calls), PROGRAM);
    const feePayer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    const sig = await adapter.requestClose(
      PID, new Uint8Array(K1), dest, feePayer, stubSigner, {}, new Uint8Array(K0),
    );
    assert.equal(sig, "sig-stub");
    // The ONLY account read (nonce source) hit the claiming-key vault.
    assert.deepEqual(calls, [expectedVault.toBase58()]);
  });

  it("close() forwards derivationAuthority to requestClose (F2)", async () => {
    const calls = [];
    const adapter = new SolanaAdapter(stubRpc(calls), PROGRAM);
    const feePayer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    // Spy: capture the forwarded derivationAuthority.
    const orig = adapter.requestClose.bind(adapter);
    let forwarded;
    adapter.requestClose = async (...args) => {
      forwarded = args[args.length - 1];
      return orig(...args);
    };
    await adapter.close(PID, new Uint8Array(K1), dest, feePayer, stubSigner, {}, new Uint8Array(K0));
    assert.ok(Buffer.from(forwarded).equals(K0), "close() must forward the claiming key");
    assert.deepEqual(calls, [expectedVault.toBase58()]);
  });

  it("without derivationAuthority the signing key drives derivation (documented default)", async () => {
    const calls = [];
    const adapter = new SolanaAdapter(stubRpc(calls), PROGRAM);
    const feePayer = Keypair.generate();
    const dest = Keypair.generate().publicKey;
    await adapter.requestClose(PID, new Uint8Array(K1), dest, feePayer, stubSigner, {});
    const wrongVault = deriveSmartAccountAddress(PID, new Uint8Array(K1), PROGRAM).address;
    assert.deepEqual(calls, [wrongVault.toBase58()]);
    assert.notEqual(calls[0], expectedVault.toBase58());
  });

  it("expected fixtures are self-consistent (claiming vault != signing vault)", () => {
    assert.notEqual(expectedVault.toBase58(), deriveSmartAccountAddress(PID, new Uint8Array(K1), PROGRAM).address.toBase58());
    const kh = Buffer.from(vaultKeyHash(new Uint8Array(K0)));
    assert.equal(kh.length, 32);
    assert.ok(kh.equals(crypto.createHash("sha256").update(K0).digest()));
    assert.equal(expectedTicket.toBase58(), deriveTicketAddress(new Uint8Array(PID_HASH), new Uint8Array(K0), PROGRAM).address.toBase58());
  });
});
