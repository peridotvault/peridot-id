// H3 mechanism vectors (ANT-575 FR-H.3): spend-rate breaker (R-NFR-9),
// bounded retries with park (R-NFR-7), plus the H1.i revocation spike monitor.
import { ServiceUnavailableException } from "@nestjs/common";
import { CircuitBreakerService } from "./circuit-breaker.service";
import { RevocationMonitor } from "./revocation-monitor.service";
import { mockSecurity } from "../../test/factories";

const PID = "pid_01HASH";

function breakerSetup(cap?: string, extraEnv: Record<string, string> = {}) {
  const security = mockSecurity();
  const env: Record<string, string> = { ...extraEnv };
  if (cap !== undefined) env["BREAKER_CAP_SOLANA"] = cap;
  const config = {
    get: jest.fn((key: string, def?: unknown) => env[key] ?? def),
    getOrThrow: jest.fn(() => {
      throw new Error("Missing config");
    }),
  };
  const service = new CircuitBreakerService(config as never, security as never);
  return { service, security };
}

describe("CircuitBreakerService", () => {
  it("stays closed and records absorbed P&L under the cap (H-AC5 negative)", async () => {
    const { service, security } = breakerSetup("1000000");
    const snap = await service.recordAbsorbed(PID, "solana", 1000n);
    expect(snap.open).toBe(false);
    expect(snap.absorbedSum).toBe("1000");
    expect(security.log).not.toHaveBeenCalledWith(PID, "relayer.breaker.opened", expect.anything());
  });

  it("opens on cap breach and fail-closes sponsored broadcasts (H-AC5)", async () => {
    const { service, security } = breakerSetup("5000");
    await service.recordAbsorbed(PID, "solana", 3000n);
    expect(service.isOpen("solana")).toBe(false);
    const snap = await service.recordAbsorbed(PID, "solana", 2500n);
    expect(snap.open).toBe(true);
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "relayer.breaker.opened",
      expect.objectContaining({ chain: "solana", absorbedSum: "5500", cap: "5000" }),
    );
    await expect(service.requireClosed("solana", "withdraw")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Re-quote path is unaffected: only sponsored broadcasts gate here.
    expect(service.isOpen("eip155:1")).toBe(false);
  });

  it("slides the 1h window and resumes only via manual close", async () => {
    const { service, security } = breakerSetup("5000");
    await service.recordAbsorbed(PID, "solana", 6000n);
    expect(service.isOpen("solana")).toBe(true);
    const snap = await service.closeBreaker(PID, "solana", "operator reviewed incident #1");
    expect(snap.open).toBe(false);
    expect(snap.absorbedSum).toBe("0");
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "relayer.breaker.closed",
      expect.objectContaining({ evidence: "operator reviewed incident #1" }),
    );
    await expect(service.requireClosed("solana", "withdraw")).resolves.toBeUndefined();
  });

  it("parks after bounded attempts instead of storming (R-NFR-7)", async () => {
    const { service, security } = breakerSetup();
    const fn = jest.fn().mockRejectedValue(new Error("rpc flake"));
    await expect(service.withBoundedRetries(PID, "solana", "withdraw", "getNonce", fn, 3)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "relay.parked_unreadable",
      expect.objectContaining({ op: "getNonce", reason: "retry-bound-exhausted" }),
    );
  });

  it("returns on first success without parking", async () => {
    const { service, security } = breakerSetup();
    const fn = jest.fn().mockResolvedValueOnce("ok");
    await expect(service.withBoundedRetries(PID, "solana", "withdraw", "getNonce", fn, 3)).resolves.toBe("ok");
    expect(security.log).not.toHaveBeenCalled();
  });

  it("honors the PID per-chain alias when BREAKER_CAP is unset (ANT-601)", async () => {
    // No BREAKER_CAP_* set: pre-rewrite PID-family operators keep enforcement.
    const { service, security } = breakerSetup(undefined, { PID_RELAYER_BREAKER_CAP_LAMPORTS_SOLANA: "5000" });
    const snap = await service.recordAbsorbed(PID, "solana", 6000n);
    expect(snap.open).toBe(true);
    expect(snap.cap).toBe("5000");
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "relayer.breaker.opened",
      expect.objectContaining({ chain: "solana", cap: "5000" }),
    );
  });

  it("prefers canonical BREAKER_CAP_<CHAIN> over the PID alias (ANT-601)", async () => {
    const { service } = breakerSetup(undefined, {
      BREAKER_CAP_SOLANA: "5000",
      PID_RELAYER_BREAKER_CAP_LAMPORTS_SOLANA: "9000",
    });
    // 6000 >= 5000 (canonical) even though < 9000 (alias): opens, cap is the BREAKER value.
    const snap = await service.recordAbsorbed(PID, "solana", 6000n);
    expect(snap.open).toBe(true);
    expect(snap.cap).toBe("5000");
  });

  it("falls back to the global PID default when no per-chain value is set (ANT-601)", async () => {
    const { service } = breakerSetup(undefined, { PID_RELAYER_BREAKER_CAP_LAMPORTS: "7000" });
    const snap = await service.recordAbsorbed(PID, "solana", 6000n);
    expect(snap.open).toBe(false);
    expect(snap.cap).toBe("7000");
  });

  it("prefers any per-chain value over the global default, regardless of family (ANT-601)", async () => {
    const { service } = breakerSetup(undefined, {
      PID_RELAYER_BREAKER_CAP_LAMPORTS: "7000",
      PID_RELAYER_BREAKER_CAP_LAMPORTS_SOLANA: "5000",
    });
    // Chain-specific alias (5000) beats the global default (7000): specificity first, family second.
    const snap = await service.recordAbsorbed(PID, "solana", 6000n);
    expect(snap.open).toBe(true);
    expect(snap.cap).toBe("5000");
  });

  it("treats empty and unparsable cap values as unset/disabled, never as enforced (ANT-601)", async () => {
    // Empty canonical value is skipped (counts as unset) → PID alias wins.
    const aliased = breakerSetup(undefined, {
      BREAKER_CAP_SOLANA: "",
      PID_RELAYER_BREAKER_CAP_LAMPORTS_SOLANA: "5000",
    });
    const snapAlias = await aliased.service.recordAbsorbed(PID, "solana", 6000n);
    expect(snapAlias.open).toBe(true);
    expect(snapAlias.cap).toBe("5000");
    // Garbage everywhere fails safe to 0 = disabled.
    const broken = breakerSetup(undefined, {
      BREAKER_CAP_SOLANA: "not-a-number",
      PID_RELAYER_BREAKER_CAP_LAMPORTS: "also-bad",
    });
    const snapBroken = await broken.service.recordAbsorbed(PID, "solana", 999_999_999n);
    expect(snapBroken.open).toBe(false);
    expect(snapBroken.cap).toBe("0");
  });
});

describe("RevocationMonitor", () => {
  it("pages on a revocation spike above 5x baseline (H-AC1)", async () => {
    const security = mockSecurity();
    const monitor = new RevocationMonitor(security as never);
    const t0 = 1_700_000_000_000;
    // Baseline: 1 revocation in the trailing hour.
    await monitor.recordRevocation(PID, "solana", t0);
    // Burst: 6 revocations inside the 10-min window → 0.6/min vs 0.117/min baseline.
    let snap = { spike: false, recentPerMin: 0, baselinePerMin: 0, chain: "solana" };
    for (let i = 1; i <= 6; i++) {
      snap = await monitor.recordRevocation(PID, "solana", t0 + i * 60_000);
    }
    expect(snap.spike).toBe(true);
    // No revocation.spike row: the spike is derived from revocation counts
    // (P1/A1), so the monitor stays silent and only flags.
    expect(security.log).not.toHaveBeenCalled();
  });

  it("stays quiet on isolated revocations", async () => {
    const security = mockSecurity();
    const monitor = new RevocationMonitor(security as never);
    const snap = await monitor.recordRevocation(PID, "global");
    expect(snap.spike).toBe(false);
    expect(security.log).not.toHaveBeenCalled();
  });
});
