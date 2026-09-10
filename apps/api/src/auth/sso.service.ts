// One-time SSO exchange codes. Issued after a successful Google/passkey login when a
// relying party on a *different* origin asked to be returned to (e.g. Live2Dev). The code
// travels in the redirect URL, then is exchanged server-to-server — no cross-site cookie
// sharing. Single-use, short TTL, bound to the issuing identity.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { PidAppsService } from "./apps.service";

const CODE_TTL_MS = 5 * 60 * 1000;

export interface SsoIdentity {
  identityId: string;
  profile: { displayName: string | null; avatarUrl: string | null };
  credentials: { provider: string; email: string | null }[];
}

/** Validated cross-domain return target: where to redirect + which app asked. */
export interface ResolvedReturnTo {
  redirectTo: string;
  clientId?: string;
}

function validHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/**
 * Loopback return targets are inherently safe and need no registration (same rule as
 * Google/Auth0: any port, any path). A pid_code redirected to the victim's *own*
 * machine can only be received there — a remote attacker gains nothing — so this can
 * never be abused the way an open redirector to arbitrary hosts could.
 */
export function isLoopbackReturnTo(returnTo: string): boolean {
  try {
    const parsed = new URL(returnTo);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Origin key for a grant (revocation granularity). Callers only pass validated http(s) URLs. */
function grantOrigin(redirectTo: string): string {
  return new URL(redirectTo).origin;
}

/** Active app connection as listed to the identity owner. */
export interface SsoGrantView {
  id: string;
  origin: string;
  clientId: string | null;
  name: string | null;
  firstSeenAt: Date;
  lastUsedAt: Date;
}
/** Opaque Google `state` carrying returnTo (+ optional clientId). Plain returnTo strings
 *  (pre-client_id clients like Live2Dev) decode via the fallback. */
export function encodeState(returnTo: string, clientId?: string): string {
  if (!clientId) return returnTo;
  return Buffer.from(JSON.stringify({ r: returnTo, c: clientId }), "utf8").toString("base64url");
}

export function decodeState(state: string): { returnTo: string; clientId?: string } {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { r?: unknown; c?: unknown };
    if (typeof parsed?.r === "string") {
      return { returnTo: parsed.r, clientId: typeof parsed.c === "string" ? parsed.c : undefined };
    }
  } catch {
    // not encoded — fall through to the legacy plain-returnTo form
  }
  return { returnTo: state };
}

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly security: SecurityEventService,
    private readonly apps: PidAppsService,
  ) {}

  /** Allowed origins for cross-domain redirects (e.g. Live2Dev). */
  allowlist(): string[] {
    return (this.config.get<string>("CLIENT_REDIRECT_ALLOWLIST", "") ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
  }

  /** True when `returnTo` is an allowed origin + any path. */
  isAllowedReturnTo(returnTo: string | undefined): boolean {
    if (!returnTo) return false;
    try {
      const parsed = new URL(returnTo);
      const origin = parsed.origin;
      if (!["http:", "https:"].includes(parsed.protocol)) return false;
      return this.allowlist().includes(origin);
    } catch {
      return false;
    }
  }

  /**
   * Validate a cross-domain return target. Loopback URLs are always allowed (no
   * registration needed — safe by network topology). With a clientId the returnTo's
   * origin must be in the app's managed allowed-origins list (the exact return URL is
   * passed in code at login time); without one, fall back to the global origin
   * allowlist. Returns null when rejected. Arbitrary hosts are NEVER allowed
   * (open-redirector identity theft) — register them via POST /v1/apps instead.
   */
  async resolveReturnTo(returnTo: string | undefined, clientId?: string): Promise<ResolvedReturnTo | null> {
    if (!returnTo || !validHttpUrl(returnTo)) return null;
    if (isLoopbackReturnTo(returnTo)) {
      // Binding still recorded when supplied, so exchange rules stay uniform.
      return { redirectTo: returnTo, clientId };
    }
    if (clientId) {
      const app = await this.apps.findActive(clientId);
      if (!app) return null;
      let origin: string;
      try {
        origin = new URL(returnTo).origin;
      } catch {
        return null;
      }
      if (!app.allowedOrigins.includes(origin)) return null;
      return { redirectTo: returnTo, clientId };
    }
    return this.isAllowedReturnTo(returnTo) ? { redirectTo: returnTo } : null;
  }

  /** Issue a single-use code bound to an identity (called right after login). */
  async issue(identityId: string, redirectTo: string, opts?: { clientId?: string; sessionId?: string }): Promise<string> {
    const code = randomBytes(24).toString("base64url");
    await this.prisma.ssoCode.create({
      data: {
        code,
        identityId,
        sessionId: opts?.sessionId ?? null,
        redirectTo,
        clientId: opts?.clientId ?? null,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });
    await this.security.log(identityId, "sso.code.issued", { redirectTo }, undefined);
    return code;
  }

  /** Consume a code and return the identity payload for the relying party. */
  async consume(code: string, clientId?: string, clientSecret?: string): Promise<SsoIdentity> {
    const row = await this.prisma.ssoCode.findUnique({ where: { code } });
    if (!row || row.consumedAt || row.expiresAt < new Date()) {
      throw new Error("sso_code_invalid");
    }
    // Codes bound to an app only exchange with the same client_id — and with the
    // app's secret when one is set (confidential clients). Uniform error, no oracle.
    if (row.clientId) {
      if (row.clientId !== clientId) throw new Error("sso_code_invalid");
      const app = await this.apps.findActive(row.clientId);
      if (!app) throw new Error("sso_code_invalid");
      if (app.clientSecretHash && !PidAppsService.secretMatches(clientSecret ?? "", app.clientSecretHash)) {
        throw new Error("sso_code_invalid");
      }
    }

    // Double-consume guard: mark consumed before returning identity.
    const updated = await this.prisma.ssoCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (updated.count === 0) throw new Error("sso_code_invalid");

    // A fresh full login records (or heals) the origin's grant: exchanging a code
    // is explicit re-consent. The one-tap `authorize` path stays blocked while
    // revoked (see AuthController) — healing only happens here.
    const origin = grantOrigin(row.redirectTo);
    await this.prisma.ssoGrant.upsert({
      where: { identityId_origin: { identityId: row.identityId, origin } },
      create: { identityId: row.identityId, origin, clientId: row.clientId },
      update: {
        lastUsedAt: new Date(),
        revokedAt: null,
        ...(row.clientId ? { clientId: row.clientId } : {}),
      },
    });

    const [profile, credentials] = await Promise.all([
      this.prisma.profile.findUnique({ where: { identityId: row.identityId } }),
      this.prisma.identityCredential.findMany({ where: { identityId: row.identityId }, select: { provider: true, email: true } }),
    ]);

    await this.security.log(row.identityId, "sso.code.consumed", {}, undefined);

    return {
      identityId: row.identityId,
      profile: { displayName: profile?.displayName ?? null, avatarUrl: profile?.avatarUrl ?? null },
      credentials,
    };
  }

  /** True when the identity revoked this origin (one-tap authorize stays blocked). */
  async isRevoked(identityId: string, redirectTo: string): Promise<boolean> {
    let origin: string;
    try {
      origin = grantOrigin(redirectTo);
    } catch {
      return false;
    }
    const grant = await this.prisma.ssoGrant.findUnique({
      where: { identityId_origin: { identityId, origin } },
    });
    return !!grant?.revokedAt;
  }

  /** Active (non-revoked) app connections, most-recently-used first. */
  async listGrants(identityId: string): Promise<SsoGrantView[]> {
    const grants = await this.prisma.ssoGrant.findMany({
      where: { identityId, revokedAt: null },
      orderBy: { lastUsedAt: "desc" },
    });
    return Promise.all(
      grants.map(async (g) => {
        let name: string | null = null;
        if (g.clientId) {
          const app = await this.apps.findActive(g.clientId).catch(() => null);
          name = app?.name ?? null;
        }
        return {
          id: g.id,
          origin: g.origin,
          clientId: g.clientId,
          name,
          firstSeenAt: g.firstSeenAt,
          lastUsedAt: g.lastUsedAt,
        };
      }),
    );
  }

  /** Disconnect an origin: stops future one-tap issuance (idempotent, identity-scoped). */
  async revokeGrant(identityId: string, id: string): Promise<void> {
    await this.prisma.ssoGrant.updateMany({
      where: { id, identityId },
      data: { revokedAt: new Date() },
    });
  }
}