// Post-auth landing: a pending PID claim must beat "home", because a signed-in
// account is what made the claim screen unreachable before.
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { landingScreen } from "../src/shared/app/landing.ts";

describe("landingScreen", () => {
  it("keeps auth-in-a-new-tab on login (it must deliver the pid_code)", () => {
    assert.equal(landingScreen({ authInNewTab: true, pendingClaim: false, needsSetup: false }), "login");
  });

  it("shows the PID picker when a claim ticket is pending, even with a session", () => {
    assert.equal(landingScreen({ authInNewTab: false, pendingClaim: true, needsSetup: true }), "login");
  });

  it("routes a returning account home and a fresh one to the stepper", () => {
    assert.equal(landingScreen({ authInNewTab: false, pendingClaim: false, needsSetup: false }), "home");
    assert.equal(landingScreen({ authInNewTab: false, pendingClaim: false, needsSetup: true }), "provisioning");
  });
});
