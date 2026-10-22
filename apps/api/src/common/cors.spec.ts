import { APP_ORIGINS_TTL_MS, FIRST_PARTY_ORIGINS, isOriginAllowed, parseEnvOrigins, staticOriginsFor } from "./cors";

describe("CORS origin policy", () => {
  const env = ["https://peridot.id", "http://localhost:3000"];
  const apps = ["https://mygame.dev"];

  it("allows first-party env origins and registered app origins", () => {
    expect(isOriginAllowed("https://peridot.id", env, apps)).toBe(true);
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

  it("serves the peridot.id first-party origins (ANT-400 hard cutover)", () => {
    const origins = parseEnvOrigins(
      "https://peridot.id,https://dashboard.peridot.id,https://docs.peridot.id,https://sandbox.peridot.id,https://sandbox-dashboard.peridot.id",
    );
    // peridot.id hosts work — no redeploy, no code branch per host.
    expect(isOriginAllowed("https://peridot.id", origins, apps)).toBe(true);
    expect(isOriginAllowed("https://dashboard.peridot.id", origins, apps)).toBe(true);
    expect(isOriginAllowed("https://docs.peridot.id", origins, apps)).toBe(true);
    expect(isOriginAllowed("https://sandbox.peridot.id", origins, apps)).toBe(true);
    expect(isOriginAllowed("https://sandbox-dashboard.peridot.id", origins, apps)).toBe(true);
    // Legacy peridotvault hosts are gone (hard cutover).
    expect(isOriginAllowed("https://app.pid.peridotvault.com", origins, apps)).toBe(false);
    expect(isOriginAllowed("https://pid.peridotvault.com", origins, apps)).toBe(false);
    // Lookalikes on the new apex are still rejected (exact match, no suffix games).
    expect(isOriginAllowed("https://peridot.id.evil.com", origins, apps)).toBe(false);
    expect(isOriginAllowed("https://evilperidot.id", origins, apps)).toBe(false);
  });

  it("refreshes app origins on a short TTL (no redeploy for new apps)", () => {
    expect(APP_ORIGINS_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it("ships every first-party origin built in (ANT-400: stale env cannot dark-out domains, legacy removed)", () => {
    const live = (origin: string): boolean => isOriginAllowed(origin, FIRST_PARTY_ORIGINS, []);
    // peridot.id hosts work even with an empty env/app list.
    for (const o of [
      "https://peridot.id",
      "https://dashboard.peridot.id",
      "https://docs.peridot.id",
      "https://sandbox.peridot.id",
      "https://sandbox-dashboard.peridot.id",
    ]) {
      expect(live(o)).toBe(true);
    }
    // Legacy hosts removed (hard cutover).
    for (const o of [
      "https://app.pid.peridotvault.com",
      "https://pid.peridotvault.com",
      "https://app.sandbox.pid.peridotvault.com",
      "https://sandbox.pid.peridotvault.com",
      "https://api.pid.peridotvault.com",
      "https://api.sandbox.pid.peridotvault.com",
    ]) {
      expect(live(o)).toBe(false);
    }
    // Lookalikes still rejected (exact match, no suffix games).
    expect(live("https://peridot.id.evil.com")).toBe(false);
    expect(live("https://evilperidot.id")).toBe(false);
  });

  it("derives the static allow-list from the service-URL set (ANT-193)", () => {
    const config = {
      get: jest.fn((key: string, def?: unknown) => {
        const values: Record<string, unknown> = {
          API_URL: "https://api.peridot.id",
          WALLET_URL: "https://peridot.id",
          DASHBOARD_URL: "https://dashboard.peridot.id",
          DOCS_URL: "https://docs.peridot.id",
        };
        return values[key] ?? def;
      }),
    } as never;
    const origins = staticOriginsFor(config);
    // Service URLs are all allowed (API + wallet + dashboard + docs).
    for (const o of [
      "https://api.peridot.id",
      "https://peridot.id",
      "https://dashboard.peridot.id",
      "https://docs.peridot.id",
    ]) {
      expect(isOriginAllowed(o, origins, [])).toBe(true);
    }
    // Built-in dual-serve backstop still applies with no env maintenance.
    expect(isOriginAllowed("https://sandbox.peridot.id", origins, [])).toBe(true);
    expect(isOriginAllowed("https://evil.com", origins, [])).toBe(false);
  });

  it("keeps CORS_ORIGINS additive for one-off edges (never required)", () => {
    const config = {
      get: jest.fn((key: string, def?: unknown) => {
        const values: Record<string, unknown> = { CORS_ORIGINS: "http://localhost:3302" };
        return values[key] ?? def;
      }),
    } as never;
    const origins = staticOriginsFor(config);
    expect(isOriginAllowed("http://localhost:3302", origins, [])).toBe(true);
    expect(isOriginAllowed("http://localhost:3300", origins, [])).toBe(true); // default API_URL
  });
});
