// ANT-589: the canonical H1/H2/H3 vocabulary matches docs/RELAYER_DASHBOARDS.md
// §1 + deploy/alerts/relayer-h1-detected.sql byte-for-byte, and money helpers
// keep base-unit strings (never floats). Pure-helper vectors ported from
// PR #107 (R-NFR-5, R-NFR-7, H3 oracle fallback) — see relayer-events.ts
// rebase note (ANT-598) for the vocabulary decision.
import {
  FEE_CHAINS,
  INTENT_REJECTION_CAUSES,
  RelayerH1Events,
  SPONSORED_ENTRY_POINTS,
  absorbedLoss,
  applyOracleFallback,
  backoffWithJitter,
  evmReferenceToFeeChain,
  fmtBaseUnits,
  isRevocationSpike,
  normalizeFeeChain,
} from "./relayer-events";
import { isDeterministicBroadcastError } from "./relayer-idempotency.service";

describe("relayer-events contract", () => {
  it("covers the five FeeChains", () => {
    expect([...FEE_CHAINS]).toEqual(["solana", "stellar", "ethereum", "base", "bsc"]);
  });

  it("covers the four sponsored entry points", () => {
    expect([...SPONSORED_ENTRY_POINTS]).toEqual(["withdraw", "execute", "rotate", "activate"]);
  });

  it("restricts rejection causes to the canonical six", () => {
    expect([...INTENT_REJECTION_CAUSES]).toEqual([
      "stale-nonce",
      "expired",
      "drift",
      "policy-unknown",
      "insufficient-funds",
      "unauthorized",
    ]);
  });

  it("uses the exact canonical event names", () => {
    expect(RelayerH1Events).toEqual({
      credentialRevoked: "credential.revoked",
      credentialRotated: "credential.rotated",
      intentRejected: "intent.rejected",
      formulaMismatch: "reconcile.formula_mismatch",
      overAttested: "reconcile.over_attested",
      pnl: "relayer.pnl",
      driftRejected: "quote.drift_rejected",
      rotationConfirmed: "rotation.confirmed",
      rotationUnconfirmed: "credential.rotation.unconfirmed",
      resolveLanded: "relay.resolve_landed",
      resolveNotLandedRebroadcast: "relay.resolve_not_landed_rebroadcast",
      parkedUnreadable: "relay.parked_unreadable",
      breakerOpened: "relayer.breaker.opened",
      breakerClosed: "relayer.breaker.closed",
    });
  });

  it("normalizes chains, bucketing anything outside FeeChain to unknown", () => {
    expect(normalizeFeeChain("solana")).toBe("solana");
    expect(normalizeFeeChain("base")).toBe("base");
    expect(normalizeFeeChain("mainnet")).toBe("unknown");
    expect(normalizeFeeChain(undefined)).toBe("unknown");
    expect(normalizeFeeChain(null)).toBe("unknown");
  });

  it("maps EVM decimal references to FeeChains", () => {
    expect(evmReferenceToFeeChain("1")).toBe("ethereum");
    expect(evmReferenceToFeeChain("8453")).toBe("base");
    expect(evmReferenceToFeeChain("56")).toBe("bsc");
    expect(evmReferenceToFeeChain("97")).toBe("unknown");
    expect(evmReferenceToFeeChain("31337")).toBe("unknown");
  });

  it("formats money as base-unit strings", () => {
    expect(fmtBaseUnits(1_000_000n)).toBe("1000000");
    expect(fmtBaseUnits(20_000_000_000_000_000n)).toBe("20000000000000000");
  });

  it("books absorbed loss as max(0, actual - attested)", () => {
    expect(absorbedLoss(5000n, 6500n)).toBe(1500n);
    expect(absorbedLoss(5000n, 5000n)).toBe(0n);
    expect(absorbedLoss(5000n, 4000n)).toBe(0n);
    expect(absorbedLoss(5000n, null)).toBe(0n);
  });
});

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
