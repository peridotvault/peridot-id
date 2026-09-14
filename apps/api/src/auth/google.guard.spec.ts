import { ServiceUnavailableException } from "@nestjs/common";
import { GoogleGuard, isGoogleAuthError } from "./google.guard";

const OPTS = { clientID: "id", clientSecret: "secret", callbackURL: "http://localhost/cb" };

describe("GoogleGuard.handleRequest", () => {
  it("maps a strategy failure to a retryable marker (never raw provider errors)", async () => {
    const guard = new GoogleGuard(OPTS);
    const out = await guard.handleRequest(new Error("invalid_grant"), undefined, undefined, undefined as never);

    expect(isGoogleAuthError(out)).toBe(true);
    expect(out).toMatchObject({ authError: "oauth_failed" });
  });

  it("maps a missing user to the same marker", async () => {
    const guard = new GoogleGuard(OPTS);
    const out = await guard.handleRequest(undefined, undefined, undefined, undefined as never);

    expect(out).toMatchObject({ authError: "oauth_failed" });
  });

  it("maps unconfigured OAuth distinctly", async () => {
    const guard = new GoogleGuard(OPTS);
    const out = await guard.handleRequest(
      new ServiceUnavailableException("nope"),
      undefined,
      undefined,
      undefined as never,
    );

    expect(out).toMatchObject({ authError: "oauth_not_configured" });
  });

  it("passes a verified identity through untouched", async () => {
    const guard = new GoogleGuard(OPTS);
    const identity = { pid: "ifal@pid" };

    expect(guard.handleRequest(undefined, identity, undefined, undefined as never)).toBe(identity);
  });
});
