// Fee-policy unit vectors (ANT-544 spec FR-B + ANT-743 pure percentage).
// Normative: outputs must match the worked examples byte/unit-exact.
// Quotes are pure `floor(networkFee × bps / 10_000)` (bps=5000 for 50%) —
// no per-chain minima, no floor leg. Amounts are integers in base units
// (no floats anywhere in fee paths, NFR-5).
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
  platformFeeWithMin,
  protocolFeeBps,
  protocolFeeOf,
  totalFeeOf,
} from "./solana-relay";

describe("fee policy — pure-percentage worked examples (normative, ANT-743)", () => {
  it("Stellar: network 0.00001 XLM → platform 0.000005 XLM → total 0.000015 XLM", () => {
    const network = 100n; // 0.00001 XLM in stroops
    expect(platformFeeOf(network, "stellar", 2)).toBe(50n);
    expect(totalFeeOf(network, "stellar", 2)).toBe(150n);
  });

  it("Solana: network 0.000005 SOL → platform 0.0000025 SOL → total 0.0000075 SOL", () => {
    const network = 5_000n; // lamports
    expect(platformFeeOf(network, "solana", 2)).toBe(2_500n);
    expect(totalFeeOf(network, "solana", 2)).toBe(7_500n);
  });

  it("Ethereum: network 0.000021 ETH → platform 0.0000105 ETH → total 0.0000315 ETH", () => {
    const network = 21_000_000_000_000n; // wei
    expect(platformFeeOf(network, "ethereum", 2)).toBe(10_500_000_000_000n);
    expect(totalFeeOf(network, "ethereum", 2)).toBe(31_500_000_000_000n);
  });

  it("Base: network 0.0000002 ETH → platform 0.0000001 ETH → total 0.0000003 ETH", () => {
    const network = 200_000_000_000n; // wei
    expect(platformFeeOf(network, "base", 2)).toBe(100_000_000_000n);
    expect(totalFeeOf(network, "base", 2)).toBe(300_000_000_000n);
  });

  it("BSC: network 0.0000021 BNB → platform 0.00000105 BNB → total 0.00000315 BNB", () => {
    const network = 2_100_000_000_000n; // wei (18 decimals)
    expect(platformFeeOf(network, "bsc", 2)).toBe(1_050_000_000_000n);
    expect(totalFeeOf(network, "bsc", 2)).toBe(3_150_000_000_000n);
  });
});

describe("fee policy — minima removed (ANT-743)", () => {
  it("zeroes the legacy per-chain minima table", () => {
    expect(CHAIN_MIN_FEE_V2.stellar).toBe(0n);
    expect(CHAIN_MIN_FEE_V2.solana).toBe(0n);
    expect(CHAIN_MIN_FEE_V2.ethereum).toBe(0n);
    expect(CHAIN_MIN_FEE_V2.base).toBe(0n);
    expect(CHAIN_MIN_FEE_V2.bsc).toBe(0n);
    // WS1 §4.2/§4.4: Monad + Arbitrum settle with NO minimum.
    expect(CHAIN_MIN_FEE_V2.monad).toBe(0n);
    expect(CHAIN_MIN_FEE_V2.arbitrum).toBe(0n);
  });

  it("returns 0 from the versioned minima accessor (deprecated)", () => {
    expect(chainMinBaseUnits("solana", 2)).toBe(0n);
    expect(chainMinBaseUnits("bsc", 2)).toBe(0n);
    expect(chainMinBaseUnits("solana", 1)).toBe(0n);
  });

  it("ignores the minima argument (deprecated wrapper)", () => {
    expect(platformFeeWithMin(5_000n, 5000, 17_000n)).toBe(2_500n);
    expect(platformFeeWithMin(200_000_000_000n, 5000, 750_000_000_000n)).toBe(100_000_000_000n);
  });

  it("matches protocolFeeOf on every chain (no floor leg anywhere)", () => {
    for (const chain of ["stellar", "solana", "ethereum", "base", "bsc"] as const) {
      for (const network of [0n, 1n, 3n, 5_000n, 21_000_000_000_000n]) {
        expect(platformFeeOf(network, chain, 2)).toBe(protocolFeeOf(network, 5000));
      }
    }
  });
});

describe("fee policy — percentage leg (spec B-AC2)", () => {
  it("takes exactly 50% (floor division, user-favorable)", () => {
    // 0.000021 ETH: floor(50%) = 10500000000000.
    expect(platformFeeOf(21_000_000_000_000n, "ethereum", 2)).toBe(10_500_000_000_000n);
  });

  it("floors the percentage leg (dust quotes zero — no minimum leg)", () => {
    // 1 lamport: floor(50%) = 0 → zero fee, exactly as shipped.
    expect(platformFeeOf(1n, "solana", 2)).toBe(0n);
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

  it("v2 row pins 5000 bps with zero minima", () => {
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
    expect(exceedsMaxTotalFee(7_500n, 7_500n)).toBe(false);
  });

  it("fails closed when totalFee exceeds maxTotalFee by one unit", () => {
    expect(exceedsMaxTotalFee(7_501n, 7_500n)).toBe(true);
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

  it("caps authorization lifetime at 600s and quote freshness at 300s", () => {
    expect(MAX_TTL_SECS).toBe(600);
    expect(QUOTE_TTL_SECS).toBe(300);
    expect(QUOTE_DRIFT_NUMERATOR).toBe(120);
    expect(QUOTE_DRIFT_DENOMINATOR).toBe(100);
  });
});

describe("EVM chain-reference → fee-chain mapping (deprecated, ANT-743)", () => {
  it("maps mainnet + testnet references to their (unused) rows", () => {
    expect(feeChainForEvmReference("1")).toBe("ethereum");
    expect(feeChainForEvmReference("11155111")).toBe("ethereum");
    expect(feeChainForEvmReference("8453")).toBe("base");
    expect(feeChainForEvmReference("84532")).toBe("base");
    expect(feeChainForEvmReference("56")).toBe("bsc");
    expect(feeChainForEvmReference("97")).toBe("bsc");
    // WS1 §4.4: Monad + Arbitrum quote a ZERO floor (matches on-chain
    // `_chainMinV2` + SDK `evmChainMinV2` — no silent Ethereum-floor markup).
    expect(feeChainForEvmReference("143")).toBe("monad");
    expect(feeChainForEvmReference("10143")).toBe("monad");
    expect(feeChainForEvmReference("42161")).toBe("arbitrum");
    expect(feeChainForEvmReference("421614")).toBe("arbitrum");
    expect(chainMinBaseUnits("monad", 2)).toBe(0n);
    expect(chainMinBaseUnits("arbitrum", 2)).toBe(0n);
    expect(platformFeeOf(200_000_000_000n, "monad", 2)).toBe(100_000_000_000n);
    expect(platformFeeOf(200_000_000_000n, "arbitrum", 2)).toBe(100_000_000_000n);
  });

  it("defaults unknown EVM references to the Ethereum row", () => {
    expect(feeChainForEvmReference("999999")).toBe("ethereum");
  });
});
