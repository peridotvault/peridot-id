import { VerificationService, XpAppStanding } from "./verification.service";

const FULL: XpAppStanding = { isActive: true, isVerified: true, xpEnabled: true, approvedEventTypes: ["onboarding", "campaign"] };

describe("VerificationService (XP permission model under ANT-428 review)", () => {
  const svc = new VerificationService();

  it("verified + XP-enabled app with approved event type can submit", () => {
    expect(svc.canSubmitEvents(FULL, "onboarding")).toEqual({ canSubmitEvents: true });
  });

  it("verification alone grants nothing — xpEnabled defaults false", () => {
    expect(svc.canSubmitEvents({ ...FULL, xpEnabled: false }, "onboarding")).toEqual({
      canSubmitEvents: false,
      reason: "App has no XP permission",
    });
  });

  it("unverified apps cannot submit even when flagged (fail closed)", () => {
    expect(svc.canSubmitEvents({ ...FULL, isVerified: false }, "onboarding").canSubmitEvents).toBe(false);
  });

  it("inactive apps cannot submit", () => {
    expect(svc.canSubmitEvents({ ...FULL, isActive: false }, "onboarding").canSubmitEvents).toBe(false);
  });

  it("unapproved event types are rejected per app", () => {
    expect(svc.canSubmitEvents(FULL, "unlisted-type")).toEqual({
      canSubmitEvents: false,
      reason: "Event type not approved: unlisted-type",
    });
  });

  it("unknown app is rejected", () => {
    expect(svc.canSubmitEvents(null, "onboarding").canSubmitEvents).toBe(false);
    expect(svc.canSubmitEvents(undefined, "onboarding").canSubmitEvents).toBe(false);
  });
});
