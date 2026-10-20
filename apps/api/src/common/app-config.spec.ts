import {
  APP_TOKEN_TTL,
  PID_ACTIVATION_CONFIRM_ATTEMPTS,
  PID_EVM_POLL_MS,
  PID_FEE_POLICY_VERSION,
  apiServesHttps,
  resolveServiceUrls,
  serviceOrigins,
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
        API_DOMAIN: "https://api.pid.peridotvault.com",
        WALLET_URL: "https://peridot.id",
        CLIENT_SUCCESS_URL: "https://app.pid.peridotvault.com",
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
      get({ API_DOMAIN: "https://api.pid.peridotvault.com", CLIENT_SUCCESS_URL: "https://app.pid.peridotvault.com" }),
    );
    expect(urls.apiUrl).toBe("https://api.pid.peridotvault.com");
    expect(urls.walletUrl).toBe("https://app.pid.peridotvault.com");
  });

  it("derives the RP ID from the wallet hostname (port stripped)", () => {
    expect(webauthnRpId(get({ WALLET_URL: "https://app.pid.peridotvault.com" }))).toBe("app.pid.peridotvault.com");
    expect(webauthnRpId(get({}))).toBe("localhost");
  });

  it("keeps an explicit WEBAUTHN_RP_ID for passkey continuity", () => {
    expect(
      webauthnRpId(get({ WALLET_URL: "https://app.pid.peridotvault.com", WEBAUTHN_RP_ID: "pid.peridotvault.com" })),
    ).toBe("pid.peridotvault.com");
  });

  it("derives cookie-secure from the API protocol unless overridden", () => {
    expect(apiServesHttps(get({ API_URL: "https://api.pid.peridotvault.com" }))).toBe(true);
    expect(apiServesHttps(get({}))).toBe(false);
  });
});
