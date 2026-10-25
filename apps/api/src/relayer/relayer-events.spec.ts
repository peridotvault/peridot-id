// H1 pure-helper vectors (ANT-575 R-NFR-5, R-NFR-7, H3 oracle fallback).
import {
  absorbedLoss,
  applyOracleFallback,
  backoffWithJitter,
  isRevocationSpike,
} from "./relayer-events";
import { isDeterministicBroadcastError } from "./relayer-idempotency.service";

describe("relayer-events helpers", () => {
  it("flags a revocation spike above 5x the trailing baseline (R-NFR-5)", () => {
    expect(isRevocationSpike(6, 1, 60)).toBe(true);
    expect(isRevocationSpike(5.01, 1, 51)).toBe(true);
    // At or below the ratio: no spike.
    expect(isRevocationSpike(5, 1, 50)).toBe(false);
    expect(isRevocationSpike(2, 1, 20)).toBe(false);
    // Zero baseline with real volume: spike; isolated revokes never page.
    expect(isRevocationSpike(0.3, 0, 3)).toBe(true);
    expect(isRevocationSpike(0.1, 0, 1)).toBe(false);
    expect(isRevocationSpike(0, 0, 0)).toBe(false);
  });

  it("books absorbed loss as max(0, actual − attested)", () => {
    expect(absorbedLoss(5000n, 7000n)).toBe(2000n);
    expect(absorbedLoss(5000n, 5000n)).toBe(0n);
    expect(absorbedLoss(5000n, 4000n)).toBe(0n);
    expect(absorbedLoss(5000n, null)).toBe(0n);
  });

  it("backs off exponentially with jitter inside [base/2, cap]", () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      for (let i = 0; i < 25; i++) {
        const d = backoffWithJitter(attempt, 500, 8000);
        const exp = Math.min(8000, 500 * 2 ** attempt);
        expect(d).toBeGreaterThanOrEqual(Math.floor(exp / 2));
        expect(d).toBeLessThanOrEqual(exp + 1);
      }
    }
  });

  it("falls back conservatively on oracle outage, fail-closed past 2x (H3)", () => {
    // Oracle down: attest last-good.
    expect(applyOracleFallback(null, 5000n)).toEqual({ ok: true, attested: 5000n, reason: "oracle-unavailable" });
    // Live below last-good: conservative = the higher.
    expect(applyOracleFallback(4000n, 5000n)).toEqual({ ok: true, attested: 5000n });
    // Live within sanity bound: attest live.
    expect(applyOracleFallback(6000n, 5000n)).toEqual({ ok: true, attested: 6000n });
    // Live beyond 2x last-good: fail closed.
    expect(applyOracleFallback(10001n, 5000n)).toEqual({
      ok: false,
      attested: 5000n,
      reason: "gas-sanity-exceeded",
    });
    expect(applyOracleFallback(10000n, 5000n).ok).toBe(true);
  });

  it("classifies deterministic vs ambiguous broadcast errors", () => {
    expect(isDeterministicBroadcastError(new Error("transaction reverted: custom 0x1"))).toBe(true);
    expect(isDeterministicBroadcastError(new Error("Simulation failed: exceeds limit"))).toBe(true);
    expect(isDeterministicBroadcastError(new Error("blockhash not found"))).toBe(true);
    // Transport/timeout failures are AMBIGUOUS → resolve-then-act.
    expect(isDeterministicBroadcastError(new Error("fetch failed: socket hang up"))).toBe(false);
    expect(isDeterministicBroadcastError(new Error("timeout of 30000ms exceeded"))).toBe(false);
    expect(isDeterministicBroadcastError(new Error("500 Internal Server Error"))).toBe(false);
  });
});
