import { googleOAuthOptionsFactory, GoogleStrategy, isPendingGoogleClaim } from "./google.strategy";

function config(env: Record<string, string | undefined>) {
  const store: Record<string, string | undefined> = { ...env };
  return { get: jest.fn((key: string, def?: string) => store[key] ?? def ?? "") } as never;
}

describe("googleOAuthOptionsFactory", () => {
  it("reads the single per-environment key set", () => {
    const opts = googleOAuthOptionsFactory(
      config({
        GOOGLE_CLIENT_ID: "my-id",
        GOOGLE_CLIENT_SECRET: "my-secret",
        GOOGLE_CALLBACK_URL: "http://localhost:3301/v1/auth/google/callback",
      }),
    );
    expect(opts).toEqual({
      clientID: "my-id",
      clientSecret: "my-secret",
      callbackURL: "http://localhost:3301/v1/auth/google/callback",
    });
  });

  it("falls back to the localhost callback URL", () => {
    const opts = googleOAuthOptionsFactory(
      config({
        GOOGLE_CLIENT_ID: "my-id",
        GOOGLE_CLIENT_SECRET: "my-secret",
      }),
    );
    expect(opts).toEqual({
      clientID: "my-id",
      clientSecret: "my-secret",
      callbackURL: "http://localhost:3301/v1/auth/google/callback",
    });
  });

  it("returns null when id or secret is missing", () => {
    expect(googleOAuthOptionsFactory(config({}))).toBeNull();
    expect(googleOAuthOptionsFactory(config({ GOOGLE_CLIENT_ID: "only-id" }))).toBeNull();
  });
});

describe("GoogleStrategy.validate", () => {
  const opts = { clientID: "id", clientSecret: "secret", callbackURL: "http://localhost/cb" };
  const profile = { id: "google-1", displayName: "New" };

  function doneValue(strategy: GoogleStrategy, req: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      void strategy.validate(req, "at", "rt", profile, (err: unknown, user?: unknown) => (err ? reject(err) : resolve(user)));
    });
  }

  it("returns the existing identity for a known credential", async () => {
    const auth = { findGoogleIdentity: jest.fn(async () => ({ pid: "ifal@pid" })) };
    const strategy = new GoogleStrategy(opts, auth as never);

    const user = await doneValue(strategy, { query: {} });
    expect(user).toMatchObject({ pid: "ifal@pid" });
  });

  it("returns a claim marker for a new credential (handles are only chosen at claim)", async () => {
    const auth = { findGoogleIdentity: jest.fn(async () => null) };
    const strategy = new GoogleStrategy(opts, auth as never);

    const user = await doneValue(strategy, { query: {} });
    expect(isPendingGoogleClaim(user)).toBe(true);
    if (isPendingGoogleClaim(user)) expect(user.claimProfile).toMatchObject({ id: "google-1" });
  });
});
