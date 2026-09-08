import { APP_ORIGINS_TTL_MS, isOriginAllowed, parseEnvOrigins } from "./cors";

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

  it("refreshes app origins on a short TTL (no redeploy for new apps)", () => {
    expect(APP_ORIGINS_TTL_MS).toBeLessThanOrEqual(60_000);
  });
});
