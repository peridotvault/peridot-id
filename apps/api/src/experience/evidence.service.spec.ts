import { EvidenceService } from "./evidence.service";

/**
 * ANT-89 M3 (ANT-441) — backend verification checkers (R3 MVP catalog).
 *
 * internal_state.* prove against PeridotID-owned rows; everything without a
 * PeridotID-side record fails CLOSED (third-party-attested-only events are
 * never awarded). Client envelopes stay generic — causes are server-side.
 */
function txFor(opts: { live?: boolean; profile?: boolean; credentials?: number } = {}) {
  const live = opts.live ?? true;
  return {
    identity: { findUnique: async () => (live ? { status: "active" } : null) },
    profile: { findUnique: async () => (opts.profile ?? true ? { pid: "user@pid" } : null) },
    identityCredential: { count: async () => opts.credentials ?? 1 },
  };
}

describe("EvidenceService (R3 MVP checkers)", () => {
  const svc = new EvidenceService();

  it("onboarding_completed verifies on live identity + profile row", async () => {
    await expect(svc.verify("internal_state.onboarding_completed", { pid: "user@pid" }, txFor() as never)).resolves.toEqual({ ok: true });
  });

  it("onboarding_completed fails closed without a profile row", async () => {
    const r = await svc.verify("internal_state.onboarding_completed", { pid: "user@pid" }, txFor({ profile: false }) as never);
    expect(r.ok).toBe(false);
  });

  it("deleted identities fail every checker", async () => {
    const tx = { identity: { findUnique: async () => ({ status: "deleted" }) }, profile: { findUnique: async () => ({ pid: "x" }) }, identityCredential: { count: async () => 3 } };
    for (const checker of ["internal_state.onboarding_completed", "internal_state.identity_verified"] as const) {
      await expect(svc.verify(checker, { pid: "user@pid" }, tx as never)).resolves.toMatchObject({ ok: false });
    }
  });

  it("identity_verified requires a linked credential", async () => {
    await expect(svc.verify("internal_state.identity_verified", { pid: "user@pid" }, txFor({ credentials: 2 }) as never)).resolves.toEqual({ ok: true });
    const r = await svc.verify("internal_state.identity_verified", { pid: "user@pid" }, txFor({ credentials: 0 }) as never);
    expect(r.ok).toBe(false);
  });

  it.each([
    "internal_state.campaign_verified",
    "backend_check.achievement_owned",
    "backend_check.activity_verified",
  ])("%s fails closed: no PeridotID-side record exists in MVP", async (checker) => {
    // Even with a live identity + profile + credentials, third-party-
    // attested-only events are REJECTED (R3) until their registries ship.
    const r = await svc.verify(checker, { pid: "user@pid", resourceId: "res-1" }, txFor() as never);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no PeridotID-side|registry|linkage/);
  });

  it("unknown checkers fail closed", async () => {
    await expect(svc.verify("bogus.checker", { pid: "user@pid" }, txFor() as never)).resolves.toMatchObject({ ok: false });
  });
});
