// Per-user throttle identity: verified-token PID gets the 500/min bucket,
// anonymous stays on the per-IP 100/min bucket. No DI here — pure functions
// over a request-shaped object, signed with jsonwebtoken directly.
import { sign } from "jsonwebtoken";
import { ExecutionContext } from "@nestjs/common";
import { Request } from "express";
import { JWT_ACCESS_AUDIENCES, JWT_ISSUER } from "./app-config";
import { skipIfAnon, skipIfAuthed, throttlePid, userThrottleTracker, verifyThrottleToken } from "./user-throttle";

const SECRET = "test-user-throttle-secret";

function signed(sub: string, over: Record<string, unknown> = {}): string {
  return sign(
    { sub, type: "access", ...over },
    SECRET,
    { issuer: JWT_ISSUER, audience: JWT_ACCESS_AUDIENCES[0], expiresIn: "1h" },
  );
}

const ctxFor = (req: Partial<Request> & { ip?: string }): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

describe("verifyThrottleToken", () => {
  it("accepts a well-formed access token and returns the PID", () => {
    expect(verifyThrottleToken(signed("ifal@pid"), SECRET)).toBe("ifal@pid");
  });

  it("rejects everything else (fail closed → anonymous bucket)", () => {
    expect(verifyThrottleToken("", SECRET)).toBeNull();
    expect(verifyThrottleToken("garbage", SECRET)).toBeNull();
    // Wrong secret: a forged sub can never mint its own bucket.
    expect(verifyThrottleToken(signed("mallory@pid"), "wrong-secret")).toBeNull();
    // Wrong type (refresh/app-shaped payloads must not pass as sessions).
    expect(verifyThrottleToken(signed("ifal@pid", { type: "refresh" }), SECRET)).toBeNull();
    // Missing sub.
    expect(verifyThrottleToken(sign({ type: "access" }, SECRET, { issuer: JWT_ISSUER }), SECRET)).toBeNull();
    // No secret configured (env missing): everything is anonymous, still limited.
    expect(verifyThrottleToken(signed("ifal@pid"), undefined)).toBeNull();
  });

  it("rejects expired tokens and tokens for a foreign issuer", () => {
    const expired = sign({ sub: "ifal@pid", type: "access" }, SECRET, {
      issuer: JWT_ISSUER,
      audience: JWT_ACCESS_AUDIENCES[0],
      expiresIn: "-1s",
    });
    expect(verifyThrottleToken(expired, SECRET)).toBeNull();
    const foreign = sign({ sub: "ifal@pid", type: "access" }, SECRET, { issuer: "evil-id" });
    expect(verifyThrottleToken(foreign, SECRET)).toBeNull();
  });
});

describe("skipIf / tracker split", () => {
  const OLD = process.env.JWT_ACCESS_SECRET;
  beforeEach(() => {
    process.env.JWT_ACCESS_SECRET = SECRET;
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = OLD;
  });

  it("a verified Bearer session skips the IP bucket and keys the user bucket", () => {
    const req = { headers: { authorization: `Bearer ${signed("ifal@pid")}` }, cookies: {}, ip: "9.9.9.9" };
    expect(skipIfAuthed(ctxFor(req))).toBe(true);
    expect(skipIfAnon(ctxFor(req))).toBe(false);
    expect(userThrottleTracker(req as Record<string, unknown>)).toBe("user:ifal@pid");
  });

  it("a verified session cookie counts too (wallet browser flow)", () => {
    const req = { headers: {}, cookies: { pid_access: signed("kupuakz@pid") }, ip: "9.9.9.9" };
    expect(skipIfAuthed(ctxFor(req))).toBe(true);
    expect(userThrottleTracker(req as Record<string, unknown>)).toBe("user:kupuakz@pid");
  });

  it("anonymous requests stay on the IP bucket in both directions", () => {
    const req = { headers: {}, cookies: {}, ip: "9.9.9.9" };
    expect(skipIfAuthed(ctxFor(req))).toBe(false);
    expect(skipIfAnon(ctxFor(req))).toBe(true);
    expect(userThrottleTracker(req as Record<string, unknown>)).toBe("user:ip:9.9.9.9");
  });

  it("a forged sub with a bad signature falls back to the IP bucket", () => {
    const req = { headers: { authorization: `Bearer ${signed("mallory@pid")}` }, cookies: {}, ip: "9.9.9.9" };
    process.env.JWT_ACCESS_SECRET = "different-secret";
    expect(skipIfAuthed(ctxFor(req))).toBe(false);
    expect(skipIfAnon(ctxFor(req))).toBe(true);
  });

  it("verifies at most once per request (skipIf + tracker share the memo)", () => {
    const req = { headers: { authorization: `Bearer ${signed("ifal@pid")}` }, cookies: {}, ip: "9.9.9.9" };
    skipIfAuthed(ctxFor(req));
    skipIfAnon(ctxFor(req));
    expect(userThrottleTracker(req as Record<string, unknown>)).toBe("user:ifal@pid");
  });
});

describe("throttlePid", () => {
  it("prefers the Bearer token and memoizes per request object", () => {
    const req = {
      headers: { authorization: `Bearer ${signed("ifal@pid")}` },
      cookies: { pid_access: signed("other@pid") },
    };
    expect(throttlePid(req as never, SECRET)).toBe("ifal@pid");
    // Memoized: even a different secret afterwards returns the first answer.
    expect(throttlePid(req as never, "wrong-secret")).toBe("ifal@pid");
  });
});
