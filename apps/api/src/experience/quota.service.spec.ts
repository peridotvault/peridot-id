import { QuotaService } from "./quota.service";

describe("QuotaService (M1 unit gate, R2)", () => {
  const svc = new QuotaService();
  const zero = { daily: 0, weekly: 0, monthly: 0 };

  it("allows under all caps", () => {
    expect(
      svc.evaluate({ periodSums: { daily: 60, weekly: 60, monthly: 60 }, deltaXp: 20, caps: { dailyCap: 100, weeklyCap: 500, monthlyCap: 2000 } }),
    ).toEqual({ allowed: true });
  });

  it("rejects over each cap independently", () => {
    expect(svc.evaluate({ periodSums: zero, deltaXp: 101, caps: { dailyCap: 100 } }).allowed).toBe(false);
    expect(svc.evaluate({ periodSums: { daily: 0, weekly: 490, monthly: 0 }, deltaXp: 20, caps: { weeklyCap: 500 } }).allowed).toBe(false);
    expect(
      svc.evaluate({ periodSums: { daily: 0, weekly: 0, monthly: 1990 }, deltaXp: 20, caps: { monthlyCap: 2000 } }).allowed,
    ).toBe(false);
  });

  it("unset caps are unbounded", () => {
    expect(svc.evaluate({ periodSums: { daily: 1e9, weekly: 1e9, monthly: 1e9 }, deltaXp: 1e6, caps: {} })).toEqual({
      allowed: true,
    });
  });

  it("exact-cap edge is allowed (Game XYZ: 5×20 = 100 daily)", () => {
    expect(svc.evaluate({ periodSums: { daily: 80, weekly: 80, monthly: 80 }, deltaXp: 20, caps: { dailyCap: 100 } })).toEqual({
      allowed: true,
    });
  });

  it("suspended short-circuits with the suspend reason", () => {
    expect(svc.evaluate({ periodSums: zero, deltaXp: 1, caps: {}, suspended: true, suspendReason: "abuse" })).toEqual({
      allowed: false,
      reason: "abuse",
    });
  });

  it("rejects negative/non-finite accounting inputs fail-closed", () => {
    expect(svc.evaluate({ periodSums: { daily: -1, weekly: 0, monthly: 0 }, deltaXp: 1, caps: {} }).allowed).toBe(false);
    expect(svc.evaluate({ periodSums: zero, deltaXp: NaN, caps: {} }).allowed).toBe(false);
  });
});
