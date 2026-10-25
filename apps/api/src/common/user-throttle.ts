import { ExecutionContext } from "@nestjs/common";
import { verify } from "jsonwebtoken";
import { Request } from "express";
import { JWT_ACCESS_AUDIENCES, JWT_ISSUER } from "./app-config";
import { ACCESS_COOKIE, normalizeScope, scopeAccessCookie } from "./cookies";

/**
 * Per-user throttle identity (authed 500/min vs anonymous 100/min per IP).
 *
 * `skipIf`/`getTracker` are plain functions (no DI — the guard calls them per
 * request), so the secret is read lazily from `process.env` at request time,
 * never at import time. Verification is local HMAC only (no DB, no I/O):
 * signature + issuer + audience + `type: "access"` must all check out, so a
 * forged `sub` can never mint its own fresh 500-bucket — it falls back to
 * the IP bucket like any anonymous request. Anything unverifiable (missing
 * secret, expired, wrong audience, non-access token) is anonymous.
 */

const VERIFIED_PID = Symbol("peridot.throttle.pid");
const VERIFIED_DONE = Symbol("peridot.throttle.done");

type ThrottleReq = Request & {
  cookies?: Record<string, string>;
  [VERIFIED_PID]?: string | null;
  [VERIFIED_DONE]?: boolean;
};

function candidateTokens(req: ThrottleReq): string[] {
  const out: string[] = [];
  const auth = req.headers?.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) out.push(auth.slice(7).trim());
  const cookies = req.cookies ?? {};
  const scope = normalizeScope(req.headers?.["x-pid-scope"]);
  if (scope) {
    const scoped = cookies[scopeAccessCookie(scope)];
    if (typeof scoped === "string" && scoped) out.push(scoped);
  } else {
    const unscoped = cookies[ACCESS_COOKIE];
    if (typeof unscoped === "string" && unscoped) out.push(unscoped);
  }
  return out.filter(Boolean);
}

/** Verify one access token locally. Returns the PID or null. Pure: secret is a param (unit-testable). */
export function verifyThrottleToken(token: string, secret: string | undefined): string | null {
  if (!token || !secret) return null;
  try {
    const payload = verify(token, secret, {
      issuer: JWT_ISSUER,
      audience: [...JWT_ACCESS_AUDIENCES],
    }) as { sub?: unknown; type?: unknown } | string;
    if (typeof payload === "string") return null;
    if (payload.type !== "access" || typeof payload.sub !== "string" || !payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Verified PID for this request, memoized on the request object (skipIf + tracker share one verify). */
export function throttlePid(req: ThrottleReq, secret: string | undefined): string | null {
  if (req[VERIFIED_DONE]) return req[VERIFIED_PID] ?? null;
  let pid: string | null = null;
  for (const token of candidateTokens(req)) {
    pid = verifyThrottleToken(token, secret);
    if (pid) break;
  }
  req[VERIFIED_PID] = pid;
  req[VERIFIED_DONE] = true;
  return pid;
}

const secretFromEnv = (): string | undefined => process.env.JWT_ACCESS_SECRET || undefined;

/** Skip the per-IP bucket when the request carries a verified session/app token. */
export function skipIfAuthed(context: ExecutionContext): boolean {
  const req = context.switchToHttp().getRequest<ThrottleReq>();
  return throttlePid(req, secretFromEnv()) !== null;
}

/** Skip the per-user bucket when there is no verified token. */
export function skipIfAnon(context: ExecutionContext): boolean {
  return !skipIfAuthed(context);
}

/** Per-user tracker — runs only when skipIfAnon passed, so a PID is memoized. Falls back to IP defensively. */
export function userThrottleTracker(req: Record<string, unknown>): string {
  const pid = (req as unknown as ThrottleReq)[VERIFIED_PID];
  if (typeof pid === "string" && pid) return `user:${pid}`;
  const ip = (req as { ip?: unknown }).ip;
  return `user:ip:${typeof ip === "string" && ip ? ip : "unknown"}`;
}

/** Per-user bucket: 500/min for verified sessions, skipped for anonymous. */
export const USER_THROTTLER = { name: "user", ttl: 60000, limit: 500 } as const;
