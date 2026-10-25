import { xpIntakeAppPidTracker, xpIntakeAppTracker } from "./rate-limit";

/**
 * ANT-89 M3 (ANT-441) — Tobias re-review S3: the F5 throttle keying is
 * load-bearing (body client_id → per-app bucket, IP fallback bounds
 * client_id rotation), so the tracker functions carry direct lock-in tests.
 */
describe("intake throttle trackers (F5 keying)", () => {
  it("keys per-app by body client_id", () => {
    expect(xpIntakeAppTracker({ body: { client_id: "pidapp_a" }, ip: "9.9.9.9" })).toBe("xp-intake-app:pidapp_a");
    expect(xpIntakeAppTracker({ body: { client_id: "pidapp_b" }, ip: "9.9.9.9" })).toBe("xp-intake-app:pidapp_b");
  });

  it("falls back to IP when client_id is absent or unusable", () => {
    expect(xpIntakeAppTracker({ body: {}, ip: "1.2.3.4" })).toBe("xp-intake-app:1.2.3.4");
    expect(xpIntakeAppTracker({ body: { client_id: "" }, ip: "1.2.3.4" })).toBe("xp-intake-app:1.2.3.4");
    expect(xpIntakeAppTracker({ body: { client_id: 42 }, ip: "1.2.3.4" })).toBe("xp-intake-app:1.2.3.4");
    expect(xpIntakeAppTracker({ ip: "1.2.3.4" })).toBe("xp-intake-app:1.2.3.4");
  });

  it("length-guards the client_id (no bucket-key blowup)", () => {
    const long = "x".repeat(129);
    expect(xpIntakeAppTracker({ body: { client_id: long }, ip: "1.2.3.4" })).toBe("xp-intake-app:1.2.3.4");
    expect(xpIntakeAppTracker({ body: { client_id: "x".repeat(128) }, ip: "1.2.3.4" })).toBe(`xp-intake-app:${"x".repeat(128)}`);
  });

  it("keys per-app+subject for the inner tier", () => {
    expect(xpIntakeAppPidTracker({ body: { client_id: "pidapp_a", user_id: "u@pid" }, ip: "9.9.9.9" })).toBe(
      "xp-intake-app-pid:pidapp_a:u@pid",
    );
    expect(xpIntakeAppPidTracker({ body: { client_id: "pidapp_a", user_id: "v@pid" }, ip: "9.9.9.9" })).toBe(
      "xp-intake-app-pid:pidapp_a:v@pid",
    );
  });

  it("falls back per-dimension (IP for app, '-' for subject)", () => {
    expect(xpIntakeAppPidTracker({ body: { user_id: "u@pid" }, ip: "1.2.3.4" })).toBe("xp-intake-app-pid:1.2.3.4:u@pid");
    expect(xpIntakeAppPidTracker({ body: { client_id: "pidapp_a" }, ip: "1.2.3.4" })).toBe("xp-intake-app-pid:pidapp_a:-");
    expect(xpIntakeAppPidTracker({ body: {}, ip: "1.2.3.4" })).toBe("xp-intake-app-pid:1.2.3.4:-");
  });

  it("length-guards both tracker dimensions (no bucket-key blowup)", () => {
    // Over-long client_id falls back to IP on BOTH tiers (attacker cannot
    // mint unbounded per-app buckets).
    expect(xpIntakeAppPidTracker({ body: { client_id: "x".repeat(129), user_id: "u@pid" }, ip: "1.2.3.4" })).toBe(
      "xp-intake-app-pid:1.2.3.4:u@pid",
    );
    // Over-long user_id degrades to the anonymous subject bucket.
    expect(xpIntakeAppPidTracker({ body: { client_id: "pidapp_a", user_id: "y".repeat(65) }, ip: "1.2.3.4" })).toBe(
      "xp-intake-app-pid:pidapp_a:-",
    );
    // Boundary values are kept verbatim (128 / 64).
    expect(
      xpIntakeAppPidTracker({ body: { client_id: "x".repeat(128), user_id: "y".repeat(64) }, ip: "1.2.3.4" }),
    ).toBe(`xp-intake-app-pid:${"x".repeat(128)}:${"y".repeat(64)}`);
  });
});
