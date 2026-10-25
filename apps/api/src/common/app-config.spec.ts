import {
  APP_TOKEN_TTL,
  JWT_ACCESS_AUDIENCES,
  JWT_AUD_APP,
  JWT_AUD_REFRESH,
  JWT_AUD_SESSION,
  JWT_AUD_SSO,
  JWT_ISSUER,
  PID_ACTIVATION_CONFIRM_ATTEMPTS,
  PID_EVM_POLL_MS,
  PID_FEE_POLICY_VERSION,
  SSO_EXCHANGE_TOKEN_TTL,
  apiServesHttps,
  parseTtlMs,
  resolveServiceUrls,
  serviceOrigins,
  ttlSeconds,
  webauthnRpId,
} from "./app-config";

function get(env: Record<string, string | undefined>) {
  return (key: string, def?: string): unknown => env[key] ?? def;
}

describe("service-URL set (ANT-193: one set, everything derived)", () => {
  it("hardcodes the former PID/EVM/app-token knobs", () => {
    expect(PID_ACTIVATION_CONFIRM_ATTEMPTS).toBe(15);
    expect(PID_FEE_POLICY_VERSION).toBe(1);
    expect(PID_EVM_POLL_MS).toBe(30_000);
    expect(APP_TOKEN_TTL).toBe("1h");
  });

  it("resolves local-dev defaults with no env", () => {
    const urls = resolveServiceUrls(get({}));
    expect(urls).toEqual({
      apiUrl: "http://localhost:3300",
      walletUrl: "http://localhost:3302",
      dashboardUrl: null,
      docsUrl: null,
    });
    expect(serviceOrigins(urls)).toEqual(["http://localhost:3300", "http://localhost:3302"]);
  });

  it("prefers API_URL/WALLET_URL over the deprecated API_DOMAIN/CLIENT_SUCCESS_URL", () => {
    const urls = resolveServiceUrls(
      get({
        API_URL: "https://api.peridot.id",
        API_DOMAIN: "https://sandbox-api.peridot.id",
        WALLET_URL: "https://peridot.id",
        CLIENT_SUCCESS_URL: "https://sandbox.peridot.id",
        DASHBOARD_URL: "https://dashboard.peridot.id",
        DOCS_URL: "https://docs.peridot.id",
      }),
    );
    expect(urls).toEqual({
      apiUrl: "https://api.peridot.id",
      walletUrl: "https://peridot.id",
      dashboardUrl: "https://dashboard.peridot.id",
      docsUrl: "https://docs.peridot.id",
    });
    expect(serviceOrigins(urls)).toEqual([
      "https://api.peridot.id",
      "https://peridot.id",
      "https://dashboard.peridot.id",
      "https://docs.peridot.id",
    ]);
  });

  it("reads the deprecated keys as a cutover fallback", () => {
    const urls = resolveServiceUrls(
      get({ API_DOMAIN: "https://sandbox-api.peridot.id", CLIENT_SUCCESS_URL: "https://sandbox.peridot.id" }),
    );
    expect(urls.apiUrl).toBe("https://sandbox-api.peridot.id");
    expect(urls.walletUrl).toBe("https://sandbox.peridot.id");
  });

  it("derives the RP ID from the wallet hostname (port stripped)", () => {
    expect(webauthnRpId(get({ WALLET_URL: "https://peridot.id" }))).toBe("peridot.id");
    expect(webauthnRpId(get({}))).toBe("localhost");
  });

  it("keeps an explicit WEBAUTHN_RP_ID for passkey continuity", () => {
    expect(
      webauthnRpId(get({ WALLET_URL: "https://peridot.id", WEBAUTHN_RP_ID: "peridot.id" })),
    ).toBe("peridot.id");
  });

  it("derives cookie-secure from the API protocol unless overridden", () => {
    expect(apiServesHttps(get({ API_URL: "https://api.peridot.id" }))).toBe(true);
    expect(apiServesHttps(get({}))).toBe(false);
  });
});

describe("TTL guards + JWT claims (ANT-227 items 1, 4, 7)", () => {
  it("parses valid durations, rejects garbage/zero/negative (never NaN downstream)", () => {
    expect(parseTtlMs("15m", "t")).toBe(15 * 60 * 1000);
    expect(parseTtlMs("24h", "t")).toBe(24 * 60 * 60 * 1000);
    expect(ttlSeconds("24h", "t")).toBe(86400);
    // ms() returns undefined for garbage (no throw) — the guard must throw.
    for (const bad of ["garbage", "", "0", "-5m", "0s"]) {
      expect(() => parseTtlMs(bad, "t")).toThrow("invalid_ttl:t");
    }
  });

  it("caps the SSO exchange bearer at 24h", () => {
    expect(SSO_EXCHANGE_TOKEN_TTL).toBe("24h");
    expect(ttlSeconds(SSO_EXCHANGE_TOKEN_TTL, "SSO_EXCHANGE_TOKEN_TTL")).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("names one issuer and a distinct audience per token class", () => {
    expect(JWT_ISSUER).toBe("peridot-id");
    expect(new Set([JWT_AUD_SESSION, JWT_AUD_REFRESH, JWT_AUD_APP, JWT_AUD_SSO]).size).toBe(4);
    expect([...JWT_ACCESS_AUDIENCES]).toEqual([JWT_AUD_SESSION, JWT_AUD_APP, JWT_AUD_SSO]);
    expect(JWT_ACCESS_AUDIENCES).not.toContain(JWT_AUD_REFRESH);
  });
});
