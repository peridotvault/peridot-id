import {
  deriveEvmSmartAccountAddress,
  deriveEvmSmartAccountAddressBound,
  pidKeyToSalt32,
  EVM_CHAINS,
  getCreate2Address,
  minimalProxyInitCode,
  keccak256,
  toChecksumAddress,
  toHex,
  fromHex,
} from "@peridotvault/pid-evm";
import { evmChainByReference, evmChains } from "./evm-account";

describe("evm-account", () => {
  it("checksums per EIP-55", () => {
    expect(toChecksumAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")).toBe(
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    );
  });

  it("derives deterministically from the pid (not the key)", () => {
    const a = deriveEvmSmartAccountAddress("ifal@pid", "0x4e59b44847b379578588920cA78FbF26c0B4956C", "0x0000000000000000000000000000000000000001");
    const b = deriveEvmSmartAccountAddress("ifal@pid", "0x4e59b44847b379578588920cA78FbF26c0B4956C", "0x0000000000000000000000000000000000000001");
    expect(a.address).toBe(b.address);
    expect(a.salt).toBe("0x98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7");
  });

  it("matches the on-chain CREATE2 prediction (forge parity vector)", () => {
    // From contracts/evm `test_LogCreate2Parity`: factory/implementation/salt are
    // fixed, PREDICT came from `Clones.predictDeterministicAddress` on-chain.
    const factory = "0x2e234DAe75C793f67A35089C9d99245E1C58470b";
    const impl = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f";
    const salt = fromHex("00000000000000000000000000000000b3f1e6a92c4d4f8b9a3e8d7c5b2a1f9e");
    const initCodeHash = keccak256(minimalProxyInitCode(impl));
    expect(getCreate2Address(factory, salt, initCodeHash)).toBe("0x883c7FcF54967D2Fc3F769E44Cd78f74560909D6");
    expect(toHex(initCodeHash)).toHaveLength(64);
  });

  it("binds the bound derivation to (pid, key) — forge parity (ANT-866/B1)", () => {
    // P-256 generator (forge privkey 1); parity from `test_LogCreate2Parity` +
    // `test_LogVectorActivate` (bound salt + predictBound, on-chain logs).
    const gx = fromHex("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296");
    const gy = fromHex("4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5");
    const factory = "0x2e234DAe75C793f67A35089C9d99245E1C58470b";
    const impl = "0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f";
    const bound = deriveEvmSmartAccountAddressBound("test@pid", gx, gy, factory, impl);
    expect(bound.pidHash).toBe("0xd7824b7df5f3b280b67abf3ac397749789aa4b6bac508d9b0df69091cb3a0cfa");
    expect(bound.salt).toBe("0x8a206329fc8eec6d5fb4e289640b278fea0f356ce47b31be5886745df25a0f2e");
    expect(bound.address).toBe("0xD202C18363FcbF6f2D68B3247600c35574b98707");
    // A different key diverges (squat lands elsewhere); same input is stable.
    const other = deriveEvmSmartAccountAddressBound("test@pid", fromHex("00".repeat(31) + "02"), gy, factory, impl);
    expect(other.address).not.toBe(bound.address);
    expect(pidKeyToSalt32("TEST@PID ", gx, gy)).toEqual(fromHex(bound.salt.slice(2))); // pid normalization
  });

  it("exposes the four phase-1 chains", () => {
    expect(EVM_CHAINS.map((c) => c.chainReference).sort()).toEqual(["10143", "421614", "84532", "97"]);
    expect(evmChainByReference("97")?.chainId).toBe(97);
    expect(evmChainByReference("84532")?.name).toBe("base-sepolia");
    expect(evmChainByReference("1")).toBeUndefined();
    expect(evmChains("97").map((c) => c.chainReference)).toEqual(["97"]);
  });
});
