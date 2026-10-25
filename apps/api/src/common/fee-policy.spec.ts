// Fee-policy v2 unit vectors (ANT-544 spec FR-B B1–B3/B7 + FR-E E3 taxonomy).
// Normative: outputs must match the §3-B3 worked examples byte/unit-exact.
// Amounts are integers in base units (no floats anywhere in fee paths, NFR-5).
import {
  CHAIN_MIN_FEE_V2,
  FEE_POLICY_TABLE,
  MAX_PROTOCOL_FEE_BPS,
  MAX_TTL_SECS,
  QUOTE_DRIFT_DENOMINATOR,
  QUOTE_DRIFT_NUMERATOR,
  QUOTE_TTL_SECS,
  chainMinBaseUnits,
  exceedsDriftBound,
  exceedsMaxTotalFee,
  feeChainForEvmReference,
  feePolicyRow,
  platformFeeOf,
  protocolFeeBps,
  totalFeeOf,
} from "./solana-relay";

describe("fee policy v2 — spec B3 worked examples (normative)", () => {
  it("Stellar: network 0.00001 XLM → platform 0.01 XLM → total 0.01001 XLM (floor wins)", () => {
    const network = 100n; // 0.00001 XLM in stroops
    expect(platformFeeOf(network, "stellar", 2)).toBe(100_000n);
    expect(totalFeeOf(network, "stellar", 2)).toBe(100_100n);
  });

  it("Solana: network 0.000005 SOL → platform 0.000017 SOL → total 0.000022 SOL (floor wins)", () => {
    const network = 5_000n; // lamports
    expect(platformFeeOf(network, "solana", 2)).toBe(17_000n);
    expect(totalFeeOf(network, "solana", 2)).toBe(22_000n);
  });

  it("Ethereum: network 0.000021 ETH → platform 0.0000105 ETH → total 0.0000315 ETH (50% wins)", () => {
    const network = 21_000_000_000_000n; // wei
    expect(platformFeeOf(network, "ethereum", 2)).toBe(10_500_000_000_000n);
    expect(totalFeeOf(network, "ethereum", 2)).toBe(31_500_000_000_000n);
  });

  it("Base: network 0.0000002 ETH → platform 0.00000075 ETH → total 0.00000095 ETH (floor wins)", () => {
    const network = 200_000_000n; // wei
    expect(platformFeeOf(network, "base", 2)).toBe(750_000_000n);
    expect(totalFeeOf(network, "base", 2)).toBe(950_000_000n);
  });

  it("BSC: network 0.0000021 BNB → platform 0.0000023 BNB → total 0.0000044 BNB (floor wins)", () => {
    const network = 2_100_000_000_000n; // wei (18 decimals)
    expect(platformFeeOf(network, "bsc", 2)).toBe(2_300_000_000_000n);
    expect(totalFeeOf(network, "bsc", 2)).toBe(4_400_000_000_000n);
  });
});

describe("fee policy v2 — per-chain minima table (spec B2)", () => {
  it("pins the B2 minima in native base units", () => {
    expect(CHAIN_MIN_FEE_V2.stellar).toBe(100_000n);
    expect(CHAIN_MIN_FEE_V2.solana).toBe(17_000n);
    expect(CHAIN_MIN_FEE_V2.ethereum).toBe(750_000_000n);
    expect(CHAIN_MIN_FEE_V2.base).toBe(750_000_000n);
    expect(CHAIN_MIN_FEE_V2.bsc).toBe(2_300_000_000_000n);
  });

  it("exposes minima through the versioned row accessor", () => {
    expect(chainMinBaseUnits("solana", 2)).toBe(17_000n);
    expect(chainMinBaseUnits("bsc", 2)).toBe(2_300_000_000_000n);
  });
});

describe("fee policy v2 — floor-wins vs 50%-wins legs (spec B-AC2/B-AC3)", () => {
  it("percentage leg wins when 50% exceeds the chain minimum (B-AC2)", () => {
    // 0.000021 ETH: floor(50%) = 10500000000000 > 750000000.
    expect(platformFeeOf(21_000_000_000_000n, "ethereum", 2)).toBe(10_500_000_000_000n);
  });

  it("floor leg wins when 50% is below the chain minimum (B-AC3)", () => {
    // Base 0.0000002 ETH: floor(50%) = 100000000 < 750000000.
    expect(platformFeeOf(200_000_000n, "base", 2)).toBe(750_000_000n);
  });

  it("floors the percentage leg user-favorably (dust falls to the minimum leg)", () => {
    // 1 lamport: floor(50%) = 0 → minimum wins.
    expect(platformFeeOf(1n, "solana", 2)).toBe(17_000n);
    // Odd values round down, never up.
    expect(platformFeeOf(3n, "stellar", 1)).toBe(1n);
  });
});

describe("fee policy versioning (spec B7/B-AC7/B-AC9)", () => {
  it("v1 row is frozen at pure-percentage semantics (never mutated)", () => {
    expect(protocolFeeBps(1)).toBe(5000);
    // V1 has no floor: 1 lamport → 0 platform fee, exactly as shipped.
    expect(platformFeeOf(1n, "solana", 1)).toBe(0n);
    expect(totalFeeOf(5_000n, "solana", 1)).toBe(7_500n);
    expect(chainMinBaseUnits("solana", 1)).toBe(0n);
  });

  it("v2 row pins 5000 bps with the B2 minima", () => {
    expect(protocolFeeBps(2)).toBe(5000);
    expect(feePolicyRow(2).bps).toBe(5000);
  });

  it("rejects unknown versions (UnknownFeePolicy — fail closed before any state write)", () => {
    expect(() => protocolFeeBps(0)).toThrow();
    expect(() => protocolFeeBps(3)).toThrow();
    expect(() => protocolFeeBps(99)).toThrow();
    expect(() => platformFeeOf(1000n, "solana", 99)).toThrow();
    expect(() => chainMinBaseUnits("solana", 99)).toThrow();
  });

  it("enforces bps ≤ MAX_PROTOCOL_FEE_BPS = 5000", () => {
    expect(MAX_PROTOCOL_FEE_BPS).toBe(5000);
    expect(FEE_POLICY_TABLE[2].bps).toBeLessThanOrEqual(MAX_PROTOCOL_FEE_BPS);
  });
});

describe("maxTotalFee bound (spec B5/B-AC5/B-AC6, edge case 4)", () => {
  it("passes when totalFee == maxTotalFee exactly (≤)", () => {
    expect(exceedsMaxTotalFee(22_000n, 22_000n)).toBe(false);
  });

  it("fails closed when totalFee exceeds maxTotalFee by one unit", () => {
    expect(exceedsMaxTotalFee(22_001n, 22_000n)).toBe(true);
  });

  it("zero maxTotalFee rejects everything (no zero-fee path exists — fail closed)", () => {
    expect(exceedsMaxTotalFee(1n, 0n)).toBe(true);
    expect(exceedsMaxTotalFee(0n, 0n)).toBe(false);
  });

  it("handles u64-scale totals without overflow", () => {
    const max = (1n << 64n) - 1n;
    expect(exceedsMaxTotalFee(max, max)).toBe(false);
    expect(exceedsMaxTotalFee(max, max - 1n)).toBe(true);
  });
});

describe("drift bound + TTL taxonomy (spec B6/E3, NFR-1/NFR-2/NFR-3)", () => {
  it("rejects attested > 120% of quote; exact 120.00% passes (edge case 4)", () => {
    expect(exceedsDriftBound(6000n, 5000n)).toBe(false);
    expect(exceedsDriftBound(6001n, 5000n)).toBe(true);
  });

  it("caps authorization TTL at 600s and quote freshness at 300s", () => {
    expect(MAX_TTL_SECS).toBe(600);
    expect(QUOTE_TTL_SECS).toBe(300);
    expect(QUOTE_DRIFT_NUMERATOR).toBe(120);
    expect(QUOTE_DRIFT_DENOMINATOR).toBe(100);
  });
});

describe("EVM chain-reference → fee-chain mapping", () => {
  it("maps mainnet + testnet references to their minima rows", () => {
    expect(feeChainForEvmReference("1")).toBe("ethereum");
    expect(feeChainForEvmReference("11155111")).toBe("ethereum");
    expect(feeChainForEvmReference("8453")).toBe("base");
    expect(feeChainForEvmReference("84532")).toBe("base");
    expect(feeChainForEvmReference("56")).toBe("bsc");
    expect(feeChainForEvmReference("97")).toBe("bsc");
  });

  it("defaults unknown EVM references to the Ethereum row", () => {
    expect(feeChainForEvmReference("999999")).toBe("ethereum");
  });
});
