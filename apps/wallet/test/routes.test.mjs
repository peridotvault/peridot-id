// URL mirror: every screen has one address, and the address resolves back.
// Run: `node --test test/` from apps/wallet.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathOf, screenOf } from "../src/shared/app/routes.ts";

const SCREENS = [
  "home",
  "send",
  "receive",
  "swap",
  "topup",
  "activity",
  "fiat-account",
  "fiat-transfer",
  "passkey",
  "chains",
  "settings",
  "profile",
  "edit-profile",
  "sessions",
  "connected",
  "app-connections",
];

describe("screen ↔ URL", () => {
  it("round-trips every linkable screen", () => {
    for (const screen of SCREENS) {
      assert.equal(screenOf(pathOf(screen)), screen, `${screen} → ${pathOf(screen)}`);
    }
  });

  it("gives login and home the root address", () => {
    assert.equal(pathOf("login"), "/");
    assert.equal(pathOf("home"), "/");
    assert.equal(screenOf("/"), "home");
  });

  it("sends detail screens to their list on a cold load", () => {
    // The URL cannot carry the item, so the address is the list.
    assert.equal(pathOf("activity-detail"), pathOf("activity"));
    assert.equal(pathOf("fiat-detail"), pathOf("fiat-account"));
    assert.equal(pathOf("fiat-ledger-detail"), pathOf("fiat-account"));
    assert.equal(screenOf(pathOf("activity-detail")), "activity");
  });

  it("ignores trailing slashes and unknown paths", () => {
    assert.equal(screenOf("/settings/"), "settings");
    assert.equal(screenOf("/nope"), null);
    assert.equal(screenOf(""), "home");
  });
});
