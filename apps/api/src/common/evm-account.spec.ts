import {
  deriveEvmSmartAccountAddress,
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

  it("derives deterministically from the account id (not the key)", () => {
    const a = deriveEvmSmartAccountAddress("b3f1e6a9-2c4d-4f8b-9a3e-8d7c5b2a1f9e", "0x4e59b44847b379578588920cA78FbF26c0B4956C", "0x0000000000000000000000000000000000000001");
    const b = deriveEvmSmartAccountAddress("b3f1e6a9-2c4d-4f8b-9a3e-8d7c5b2a1f9e", "0x4e59b44847b379578588920cA78FbF26c0B4956C", "0x0000000000000000000000000000000000000001");
    expect(a.address).toBe(b.address);
    expect(a.salt).toBe("0x00000000000000000000000000000000b3f1e6a92c4d4f8b9a3e8d7c5b2a1f9e");
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

  it("exposes the four phase-1 chains", () => {
    expect(EVM_CHAINS.map((c) => c.chainReference).sort()).toEqual(["10143", "421614", "84532", "97"]);
    expect(evmChainByReference("97")?.chainId).toBe(97);
    expect(evmChainByReference("84532")?.name).toBe("base-sepolia");
    expect(evmChainByReference("1")).toBeUndefined();
    expect(evmChains("97").map((c) => c.chainReference)).toEqual(["97"]);
  });
});
