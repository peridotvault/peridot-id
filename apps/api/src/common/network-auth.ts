import type { Request } from "express";
import { ACCESS_COOKIE, normalizeScope, scopeAccessCookie } from "./cookies";
import { mainnetApiBase } from "./app-config";
import { pidNetwork } from "./network";

/**
 * Session verification for the testnet stack.
 *
 * Identity lives in the mainnet DB only, so the testnet API cannot verify a
 * browser session itself. It asks the mainnet deployment once
 * (`GET /v1/auth/introspect`) and caches the answer briefly — no shared JWT
 * secret, no second identity store, no new env var (the mainnet origin is
 * derived from this deployment's `API_URL`, see `stripSandboxHost`).
 *
 * The cache trades at most CACHE_TTL_MS of staleness for one HTTP call per
 * token per minute; revocation therefore lags by that window, the same order
 * as the access-token TTL itself.
 */

export interface MainnetSession {
  pid: string;
  scope?: string;
  app?: string;
}

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 2_000;

const cache = new Map<string, { session: MainnetSession; expiresAt: number }>();

/** Test helper: drop cached introspections. */
export function resetMainnetSessionCache(): void {
  cache.clear();
}

/** Session token from the request: scoped/unscoped access cookie first, then Bearer. */
export function sessionToken(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const scope = normalizeScope(req.headers["x-pid-scope"]);
  const fromCookie = scope ? cookies?.[scopeAccessCookie(scope)] : cookies?.[ACCESS_COOKIE];
  if (fromCookie) return fromCookie;
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

/**
 * Resolve the mainnet session behind `req`. Null means "not authenticated" —
 * callers fail closed with a 401, exactly like a bad token on the mainnet
 * stack.
 */
export async function mainnetSession(
  req: Request,
  opts: { network?: string; baseUrl?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<MainnetSession | null> {
  if (pidNetwork(opts.network) !== "testnet") return null;
  const baseUrl = opts.baseUrl === undefined ? mainnetApiBase() : opts.baseUrl;
  if (!baseUrl) return null;
  const token = sessionToken(req);
  if (!token) return null;
  const hit = cache.get(token);
  if (hit && hit.expiresAt > Date.now()) return hit.session;
  if (hit) cache.delete(token);

  try {
    const res = await (opts.fetchImpl ?? fetch)(`${baseUrl}/v1/auth/introspect`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      // Same hop as the identity proxy: a stuck mainnet must fail closed fast.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: unknown; scope?: unknown; app?: unknown };
    if (typeof body.pid !== "string" || body.pid.length === 0) return null;
    const session: MainnetSession = {
      pid: body.pid,
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      ...(typeof body.app === "string" ? { app: body.app } : {}),
    };
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(token, { session, expiresAt: Date.now() + CACHE_TTL_MS });
    return session;
  } catch {
    // Mainnet unreachable: fail closed (no session), never guess.
    return null;
  }
}
