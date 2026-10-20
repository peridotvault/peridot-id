import { APP_ORIGINS_TTL_MS, FIRST_PARTY_ORIGINS, isOriginAllowed, parseEnvOrigins } from "./cors";

describe("CORS origin policy", () => {
  const env = ["https://app.pid.peridotvault.com", "http://localhost:3000"];
  const apps = ["https://mygame.dev"];

  it("allows first-party env origins and registered app origins", () => {
    expect(isOriginAllowed("https://app.pid.peridotvault.com", env, apps)).toBe(true);
    expect(isOriginAllowed("https://mygame.dev", env, apps)).toBe(true);
  });

  it("rejects unknown origins (no open redirect / data leak to arbitrary sites)", () => {
    expect(isOriginAllowed("https://evil.com", env, apps)).toBe(false);
    expect(isOriginAllowed("https://mygame.dev.evil.com", env, apps)).toBe(false);
    expect(isOriginAllowed("https://mygame.dev:443.evil.com", env, apps)).toBe(false);
  });

  it("allows non-browser clients with no Origin header", () => {
    expect(isOriginAllowed(undefined, env, apps)).toBe(true);
  });

  it("tolerates trailing slashes", () => {
    expect(isOriginAllowed("https://mygame.dev/", env, apps)).toBe(true);
  });

  it("parses the env list, dropping blanks", () => {
    expect(parseEnvOrigins("https://a.com, https://b.com/ ,,")).toEqual(["https://a.com", "https://b.com"]);
    expect(parseEnvOrigins(undefined)).toEqual([]);
  });

  it("dual-serves old + new first-party origins side by side (ANT-116)", () => {
    const dual = parseEnvOrigins(
      "https://app.pid.peridotvault.com,https://pid.peridotvault.com,https://peridot.id,https://dashboard.peridot.id,https://docs.peridot.id",
    );
    // Old hosts keep working (existing integrations unaffected).
    expect(isOriginAllowed("https://app.pid.peridotvault.com", dual, apps)).toBe(true);
    expect(isOriginAllowed("https://pid.peridotvault.com", dual, apps)).toBe(true);
    // New peridot.id hosts work alongside — no redeploy, no code branch per host.
    expect(isOriginAllowed("https://peridot.id", dual, apps)).toBe(true);
    expect(isOriginAllowed("https://dashboard.peridot.id", dual, apps)).toBe(true);
    expect(isOriginAllowed("https://docs.peridot.id", dual, apps)).toBe(true);
    // Lookalikes on the new apex are still rejected (exact match, no suffix games).
    expect(isOriginAllowed("https://peridot.id.evil.com", dual, apps)).toBe(false);
    expect(isOriginAllowed("https://evilperidot.id", dual, apps)).toBe(false);
  });

  it("refreshes app origins on a short TTL (no redeploy for new apps)", () => {
    expect(APP_ORIGINS_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it("ships every first-party dual-serve origin built in (ANT-143: stale env cannot dark-out new domains)", () => {
    const live = (origin: string): boolean => isOriginAllowed(origin, FIRST_PARTY_ORIGINS, []);
    // New peridot.id hosts work even with an empty env/app list.
    for (const o of [
      "https://peridot.id",
      "https://dashboard.peridot.id",
      "https://docs.peridot.id",
      "https://sandbox.peridot.id",
      "https://sandbox.dashboard.peridot.id",
      "https://sandbox.docs.peridot.id",
    ]) {
      expect(live(o)).toBe(true);
    }
    // Old hosts kept live (dual-serve, never removed).
    for (const o of [
      "https://app.pid.peridotvault.com",
      "https://pid.peridotvault.com",
      "https://app.sandbox.pid.peridotvault.com",
      "https://sandbox.pid.peridotvault.com",
    ]) {
      expect(live(o)).toBe(true);
    }
    // Lookalikes still rejected (exact match, no suffix games).
    expect(live("https://peridot.id.evil.com")).toBe(false);
    expect(live("https://evilperidot.id")).toBe(false);
  });
});
