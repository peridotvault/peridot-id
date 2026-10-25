// ANT-589 H3: breaker opens on cap breach with the exact contract keys
// (chain/absorbedSum/cap/window/reason; operator+evidence on close), reads the
// BREAKER_CAP_* env contract, and stays disabled when no cap is configured.
import { ServiceUnavailableException } from "@nestjs/common";
import { mockSecurity } from "../../test/factories";
import { CircuitBreakerService } from "./circuit-breaker.service";

function setup(caps: Record<string, string> = {}) {
  const config = {
    get: jest.fn((key: string, def?: unknown) => caps[key] ?? def),
  };
  const security = mockSecurity();
  const service = new CircuitBreakerService(config as never, security as never);
  return { service, security };
}

describe("CircuitBreakerService", () => {
  it("stays disabled without configured caps (no behavior change)", async () => {
    const { service, security } = setup();
    const snap = await service.recordAbsorbed("pid_01HASH", "solana", 10_000_000n);
    expect(snap.open).toBe(false);
    expect(security.log).not.toHaveBeenCalledWith(
      "pid_01HASH",
      "relayer.breaker.opened",
      expect.anything(),
    );
  });

  it("treats a malformed cap as disabled", async () => {
    const { service, security } = setup({ BREAKER_CAP_SOLANA: "not-a-number" });
    const snap = await service.recordAbsorbed("pid_01HASH", "solana", 10_000_000n);
    expect(snap.open).toBe(false);
    expect(security.log).not.toHaveBeenCalledWith(
      "pid_01HASH",
      "relayer.breaker.opened",
      expect.anything(),
    );
  });

  it("opens on cap breach with the exact H3 keys and blocks broadcasts", async () => {
    const { service, security } = setup({ BREAKER_CAP_SOLANA: "1000" });
    await service.recordAbsorbed("pid_01HASH", "solana", 400n);
    expect(service.isOpen("solana")).toBe(false);
    const snap = await service.recordAbsorbed("pid_01HASH", "solana", 800n);
    expect(snap).toEqual({ chain: "solana", open: true, absorbedSum: "1200", cap: "1000" });
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "relayer.breaker.opened", {
      chain: "solana",
      absorbedSum: "1200",
      cap: "1000",
      window: "1h",
      reason: "cap-breached",
    });
    await expect(service.requireClosed("solana", "withdraw")).rejects.toThrow(ServiceUnavailableException);
    // Second breach while open does not double-emit.
    await service.recordAbsorbed("pid_01HASH", "solana", 500n);
    expect(
      (security.log as jest.Mock).mock.calls.filter((c) => c[1] === "relayer.breaker.opened"),
    ).toHaveLength(1);
  });

  it("lets closed chains through the guard", async () => {
    const { service } = setup({ BREAKER_CAP_SOLANA: "1000" });
    await expect(service.requireClosed("solana", "withdraw")).resolves.toBeUndefined();
  });

  it("closes manually with operator + evidence on the canonical row", async () => {
    const { service, security } = setup({ BREAKER_CAP_SOLANA: "1000" });
    await service.recordAbsorbed("pid_01HASH", "solana", 1000n);
    expect(service.isOpen("solana")).toBe(true);
    const snap = await service.closeBreaker(
      "op@pid",
      "solana",
      "root cause: oracle lag; A3 quiet 30m; A4 under 50%; float topped up; reconcile re-run passed",
    );
    expect(snap).toEqual({ chain: "solana", open: false, absorbedSum: "0", cap: "1000" });
    expect(security.log).toHaveBeenCalledWith("op@pid", "relayer.breaker.closed", {
      chain: "solana",
      absorbedSum: "1000",
      cap: "1000",
      window: "1h",
      reason: "manual-resume",
      operator: "op@pid",
      evidence:
        "root cause: oracle lag; A3 quiet 30m; A4 under 50%; float topped up; reconcile re-run passed",
    });
    await expect(service.requireClosed("solana", "withdraw")).resolves.toBeUndefined();
  });

  it("rejects unknown chains and empty evidence on close", async () => {
    const { service } = setup({ BREAKER_CAP_SOLANA: "1000" });
    await expect(service.closeBreaker("op@pid", "mainnet", "evidence")).rejects.toThrow();
    await expect(service.closeBreaker("op@pid", "solana", "")).rejects.toThrow();
  });

  it("supports the manual freeze path with a reason", async () => {
    const { service, security } = setup({ BREAKER_CAP_BASE: "1000000" });
    const snap = await service.openBreaker("op@pid", "base", "compromise wave freeze (runbook §2)");
    expect(snap.open).toBe(true);
    expect(security.log).toHaveBeenCalledWith("op@pid", "relayer.breaker.opened", {
      chain: "base",
      absorbedSum: "0",
      cap: "1000000",
      window: "1h",
      reason: "compromise wave freeze (runbook §2)",
    });
  });
});
