import {
  QUOTE_DRIFT_DENOMINATOR,
  QUOTE_DRIFT_NUMERATOR,
  exceedsDriftBound,
  parseRelayerSvmSecretBytes,
  protocolFeeBps,
  protocolFeeOf,
  relayerKeypair,
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
  it("resolves the v1/v2 policies to 5000 bps", () => {
    expect(protocolFeeBps(1)).toBe(5000);
    expect(protocolFeeBps(2)).toBe(5000);
  });

  it("rejects unknown policy versions", () => {
    expect(() => protocolFeeBps(3)).toThrow();
    expect(() => protocolFeeBps(0)).toThrow();
  });

  it("floors the protocol fee (user-favorable rounding)", () => {
    expect(protocolFeeOf(10000n, 5000)).toBe(5000n);
    expect(protocolFeeOf(1n, 5000)).toBe(0n);
    expect(protocolFeeOf(3n, 5000)).toBe(1n);
  });
});

describe("relayer SVM secret (ANT-920)", () => {
  const fromHex = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
  const fakePs = {
    Keypair: { fromSecretKey: (b: Uint8Array) => ({ secretKey: b }) },
    fromHex,
  } as never;
  const cfg = (vals: Record<string, string>) =>
    ({
      getOrThrow: (key: string) => {
        if (key in vals) return vals[key];
        throw new Error(`Missing config: ${key}`);
      },
    }) as never;
  const HEX = "11".repeat(64);
  const ARR = `[${Array.from({ length: 64 }, (_, i) => i % 256).join(",")}]`;

  it("parses 64-byte hex", () => {
    expect(parseRelayerSvmSecretBytes(fromHex, HEX)).toHaveLength(64);
  });

  it("parses 0x-prefixed hex", () => {
    expect(parseRelayerSvmSecretBytes(fromHex, `0x${HEX}`)).toHaveLength(64);
  });

  it("parses a JSON 64-byte array (solana-keygen shape)", () => {
    const out = parseRelayerSvmSecretBytes(fromHex, ARR);
    expect(out).toHaveLength(64);
    expect(out[0]).toBe(0);
    expect(out[63]).toBe(63);
  });

  it("rejects truncated hex and wrong-length arrays (fail closed)", () => {
    expect(() => parseRelayerSvmSecretBytes(fromHex, "abcd")).toThrow();
    expect(() => parseRelayerSvmSecretBytes(fromHex, "[1,2,3]")).toThrow();
    expect(() => parseRelayerSvmSecretBytes(fromHex, "not-a-key")).toThrow();
  });

  it("prefers RELAYER_SVM_SECRET_KEY over the legacy fallback", () => {
    const kp = relayerKeypair(fakePs, cfg({
      RELAYER_SVM_SECRET_KEY: ARR,
      PID_RELAYER_SECRET: HEX,
    })) as unknown as { secretKey: Uint8Array };
    expect(kp.secretKey[0]).toBe(0);
    expect(kp.secretKey[63]).toBe(63);
  });

  it("honors the legacy PID_RELAYER_SECRET fallback when the new key is unset", () => {
    const kp = relayerKeypair(fakePs, cfg({ PID_RELAYER_SECRET: HEX })) as unknown as {
      secretKey: Uint8Array;
    };
    expect(kp.secretKey).toHaveLength(64);
    expect(kp.secretKey[0]).toBe(0x11);
  });

  it("throws when neither key is set", () => {
    expect(() => relayerKeypair(fakePs, cfg({}))).toThrow();
  });
});
