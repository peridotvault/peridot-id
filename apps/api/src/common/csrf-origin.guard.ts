import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { APP_ORIGINS_TTL_MS, isOriginAllowed, staticOriginsFor } from "./cors";
import { PrismaService } from "../prisma/prisma.service";

/**
 * CSRF Origin allowlist guard (ANT-367, parent ANT-366 audit ANT-340 M3).
 *
 * Cookie auth is SameSite=Lax only (see common/cookies.ts) — Lax already
 * blocks cross-site POST cookie sends in modern browsers, but same-site
 * (subdomain) and non-browser-driven cross-origin paths remain. This guard
 * fail-closes state-changing cookie requests against the SAME allowlist the
 * credentialed CORS policy uses:
 *   staticOriginsFor() (service URLs ∪ FIRST_PARTY_ORIGINS ∪ CORS_ORIGINS)
 *   ∪ verified per-app allowedOrigins (same source as main.ts CORS refresh).
 *
 * Rules:
 * - Safe methods (GET/HEAD/OPTIONS) always pass.
 * - Requests WITHOUT a session cookie (Bearer-token / non-browser flows)
 *   always pass — non-cookie auth is unaffected.
 * - Requests WITH a session cookie on unsafe methods MUST carry an
 *   allowlisted Origin (else Referer origin). Missing OR mismatched →
 *   403 fail-closed.
 *
 * SameSite stays Lax; CORS behavior is unchanged — this guard only rejects,
 * never widens, what CORS already decided.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Every session cookie name minted in common/cookies.ts starts with `pid_`. */
export function hasSessionCookie(cookies: Record<string, string> | undefined): boolean {
  return Object.keys(cookies ?? {}).some((k) => k.startsWith("pid_"));
}

/** Browser Origin header, else the origin of the Referer header, else undefined. */
export function extractRequestOrigin(req: Request): string | undefined {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
  if (origin) return origin.replace(/\/+$/, "");
  const referer =
    (typeof req.headers.referer === "string" ? req.headers.referer : "") ||
    (typeof (req.headers as Record<string, unknown>).referrer === "string"
      ? ((req.headers as Record<string, unknown>).referrer as string)
      : "");
  const ref = referer.trim();
  if (!ref) return undefined;
  try {
    return new URL(ref).origin;
  } catch {
    return undefined;
  }
}

/**
 * Shared verified-app origins cache (module scope, so every guard instance —
 * the CsrfOriginGuard singleton per module AND the JwtAuthGuard-embedded
 * check — shares one TTL window and one DB query, never N+1 per request).
 */
let sharedAppOrigins: string[] = [];
let sharedAppOriginsAt = 0;
let sharedAppOriginsInFlight: Promise<string[]> | null = null;

/** Test-only reset for the shared app-origins cache. */
export function __resetCsrfAppOriginsForTests(): void {
  sharedAppOrigins = [];
  sharedAppOriginsAt = 0;
  sharedAppOriginsInFlight = null;
}

export async function getVerifiedAppOrigins(prisma?: { pidApp: { findMany(args: unknown): Promise<Array<{ allowedOrigins: string[] }>> } } | undefined): Promise<string[]> {
  if (Date.now() - sharedAppOriginsAt < APP_ORIGINS_TTL_MS) return sharedAppOrigins;
  if (!prisma) return sharedAppOrigins;
  if (!sharedAppOriginsInFlight) {
    let query: Promise<Array<{ allowedOrigins: string[] }>>;
    try {
      query = prisma.pidApp.findMany({
        where: { isActive: true, isVerified: true },
        select: { allowedOrigins: true },
      });
    } catch {
      // Partial Prisma mock (unit tests) without pidApp — fall back to the
      // static list alone rather than 500ing on a TypeError.
      return sharedAppOrigins;
    }
    sharedAppOriginsInFlight = query
      .then((apps) => {
        sharedAppOrigins = apps.flatMap((a) => a.allowedOrigins);
        sharedAppOriginsAt = Date.now();
        return sharedAppOrigins;
      })
      .catch(() => {
        // DB unreachable — keep the last-known (or empty) list, fail closed
        // on the static list alone rather than failing open or 500ing.
        return sharedAppOrigins;
      })
      .finally(() => {
        sharedAppOriginsInFlight = null;
      });
  }
  return sharedAppOriginsInFlight;
}

@Injectable()
export class CsrfOriginGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
    if (!hasSessionCookie(cookies)) return true;
    const origin = extractRequestOrigin(req);
    const staticOrigins = staticOriginsFor(this.config);
    const appOrigins = await getVerifiedAppOrigins(this.prisma);
    if (!origin || !isOriginAllowed(origin, staticOrigins, appOrigins)) {
      throw new ForbiddenException("Origin not allowed for cookie-authenticated request");
    }
    return true;
  }
}
