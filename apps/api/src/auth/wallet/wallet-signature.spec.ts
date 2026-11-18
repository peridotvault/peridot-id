import { generateKeyPairSync, sign } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { encodeBase58, normalizeWalletAddress, verifyWalletSignature } from "./wallet-signature";

// Real signatures, both chains: the verifier is the trust boundary, so it is
// never exercised through a mock.
function solanaSigner() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const address = encodeBase58(raw);
  return {
    address,
    sign: (message: string) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
  };
}

describe("normalizeWalletAddress", () => {
  it("lowercases EVM and keeps Solana case verbatim", () => {
    const solana = solanaSigner().address;
    expect(normalizeWalletAddress("evm", "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01")).toBe(
      "0xabcdef0123456789abcdef0123456789abcdef01",
    );
    expect(normalizeWalletAddress("solana", solana)).toBe(solana);
    expect(normalizeWalletAddress("solana", solana.toLowerCase())).not.toBe(solana);
  });

  it("rejects malformed addresses", () => {
    expect(normalizeWalletAddress("evm", "0x1234")).toBeNull();
    expect(normalizeWalletAddress("solana", "not-a-key")).toBeNull();
    expect(normalizeWalletAddress("solana", "")).toBeNull();
  });
});

describe("verifyWalletSignature", () => {
  const message = "PeridotID wants you to sign in\nNonce: abc";

  it("accepts a Solana signature over the exact bytes", async () => {
    const signer = solanaSigner();
    await expect(
      verifyWalletSignature({ namespace: "solana", address: signer.address, message, signature: signer.sign(message) }),
    ).resolves.toBe(true);
  });

  it("rejects a Solana signature over different bytes or a tampered signature", async () => {
    const signer = solanaSigner();
    const signature = signer.sign(message);
    await expect(
      verifyWalletSignature({ namespace: "solana", address: signer.address, message: "other", signature }),
    ).resolves.toBe(false);
    const flipped = Buffer.from(signature, "base64");
    flipped[0] ^= 0xff;
    await expect(
      verifyWalletSignature({
        namespace: "solana",
        address: signer.address,
        message,
        signature: flipped.toString("base64"),
      }),
    ).resolves.toBe(false);
  });

  it("accepts an EVM signature and rejects a mismatch", async () => {
    const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const signature = await account.signMessage({ message });
    await expect(
      verifyWalletSignature({ namespace: "evm", address: account.address, message, signature }),
    ).resolves.toBe(true);
    await expect(
      verifyWalletSignature({ namespace: "evm", address: account.address, message: "other", signature }),
    ).resolves.toBe(false);
    // Another address's valid signature must never verify for this one.
    await expect(
      verifyWalletSignature({
        namespace: "evm",
        address: "0x0000000000000000000000000000000000000001",
        message,
        signature,
      }),
    ).resolves.toBe(false);
  });

  it("never throws on garbage input", async () => {
    await expect(
      verifyWalletSignature({ namespace: "evm", address: "0xzz", message, signature: "0x00" }),
    ).resolves.toBe(false);
    await expect(
      verifyWalletSignature({ namespace: "solana", address: solanaSigner().address, message, signature: "!!" }),
    ).resolves.toBe(false);
  });
});
