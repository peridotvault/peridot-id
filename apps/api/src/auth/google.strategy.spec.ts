import { googleOAuthOptionsFactory } from "./google.strategy";

function config(env: Record<string, string | undefined>, nodeEnv?: string) {
  const store: Record<string, string | undefined> = { ...env };
  if (nodeEnv !== undefined) store.NODE_ENV = nodeEnv;
  return { get: jest.fn((key: string, def?: string) => store[key] ?? def ?? "") } as never;
}

describe("googleOAuthOptionsFactory", () => {
  it("picks the DEV set outside production", () => {
    const opts = googleOAuthOptionsFactory(
      config({
        GOOGLE_CLIENT_ID_DEV: "dev-id",
        GOOGLE_CLIENT_SECRET_DEV: "dev-secret",
        GOOGLE_CALLBACK_URL_DEV: "http://localhost:3301/v1/auth/google/callback",
      }),
    );
    expect(opts).toEqual({
      clientID: "dev-id",
      clientSecret: "dev-secret",
      callbackURL: "http://localhost:3301/v1/auth/google/callback",
    });
  });

  it("picks the PROD set when NODE_ENV=production", () => {
    const opts = googleOAuthOptionsFactory(
      config(
        {
          GOOGLE_CLIENT_ID_PROD: "prod-id",
          GOOGLE_CLIENT_SECRET_PROD: "prod-secret",
          GOOGLE_CALLBACK_URL_PROD: "https://api.pid.peridotvault.com/v1/auth/google/callback",
        },
        "production",
      ),
    );
    expect(opts).toEqual({
      clientID: "prod-id",
      clientSecret: "prod-secret",
      callbackURL: "https://api.pid.peridotvault.com/v1/auth/google/callback",
    });
  });

  it("falls back to unprefixed names (legacy)", () => {
    const opts = googleOAuthOptionsFactory(
      config({
        GOOGLE_CLIENT_ID: "legacy-id",
        GOOGLE_CLIENT_SECRET: "legacy-secret",
      }),
    );
    expect(opts).toEqual({
      clientID: "legacy-id",
      clientSecret: "legacy-secret",
      callbackURL: "http://localhost:3301/v1/auth/google/callback",
    });
  });

  it("returns null when neither set is configured", () => {
    expect(googleOAuthOptionsFactory(config({}))).toBeNull();
  });
});
