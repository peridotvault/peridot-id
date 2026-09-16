import {
  QUOTE_DRIFT_DENOMINATOR,
  QUOTE_DRIFT_NUMERATOR,
  exceedsDriftBound,
  protocolFeeBps,
  protocolFeeOf,
} from "./solana-relay";

describe("quote drift bound (120.00% integer ratio, no floats)", () => {
  it("encodes exactly 120%", () => {
    expect(QUOTE_DRIFT_NUMERATOR).toBe(120);
    expect(QUOTE_DRIFT_DENOMINATOR).toBe(100);
  });

  it("passes at exactly 120% (strict > comparison)", () => {
    // 6000 × 100 == 5000 × 120 → not a violation.
    expect(exceedsDriftBound(6000n, 5000n)).toBe(false);
  });

  it("rejects one unit above 120%", () => {
    // 6001 × 100 > 5000 × 120 → violation.
    expect(exceedsDriftBound(6001n, 5000n)).toBe(true);
  });

  it("rejects clearly drifted attestations", () => {
    expect(exceedsDriftBound(820880n, 100000n)).toBe(true);
  });

  it("handles the zero-quote edge without division", () => {
    // quoted 0 with positive attestation always violates; 0/0 passes (nothing to drift).
    expect(exceedsDriftBound(1n, 0n)).toBe(true);
    expect(exceedsDriftBound(0n, 0n)).toBe(false);
  });

  it("handles u64-scale values without overflow", () => {
    const max = (1n << 64n) - 1n;
    expect(exceedsDriftBound(max, max)).toBe(false);
    // A 1-wei difference at u64 scale is far inside the bound — correctly passes.
    expect(exceedsDriftBound(max, max - 1n)).toBe(false);
    // Exact 120% at scale passes; one wei above rejects.
    const q = 10n ** 18n;
    const atBound = q + q / 5n; // exactly 1.2e18
    expect(exceedsDriftBound(atBound, q)).toBe(false);
    expect(exceedsDriftBound(atBound + 1n, q)).toBe(true);
    expect(exceedsDriftBound(max, max / 2n)).toBe(true);
  });
});

describe("protocol fee math", () => {
  it("resolves the v1 policy to 5000 bps", () => {
    expect(protocolFeeBps(1)).toBe(5000);
  });

  it("rejects unknown policy versions", () => {
    expect(() => protocolFeeBps(2)).toThrow();
    expect(() => protocolFeeBps(0)).toThrow();
  });

  it("floors the protocol fee (user-favorable rounding)", () => {
    expect(protocolFeeOf(10000n, 5000)).toBe(5000n);
    expect(protocolFeeOf(1n, 5000)).toBe(0n);
    expect(protocolFeeOf(3n, 5000)).toBe(1n);
  });
});
