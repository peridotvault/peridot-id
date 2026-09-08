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
   * Validate a cross-domain return target. With a clientId the returnTo must start with
   * one of the app's registered redirect URIs (prefix match so `?pid_code=` can append);
   * without one, fall back to the global origin allowlist (pre-client_id clients).
   * Returns null when rejected.
   */
  async resolveReturnTo(returnTo: string | undefined, clientId?: string): Promise<ResolvedReturnTo | null> {
    if (!returnTo || !validHttpUrl(returnTo)) return null;
    if (clientId) {
      const app = await this.apps.findActive(clientId);
      if (!app) return null;
      const ok = app.redirectUris.some((uri) => returnTo === uri || returnTo.startsWith(`${uri}?`) || returnTo.startsWith(`${uri}#`));
      if (!ok) return null;
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
  async consume(code: string, clientId?: string): Promise<SsoIdentity> {
    const row = await this.prisma.ssoCode.findUnique({ where: { code } });
    if (!row || row.consumedAt || row.expiresAt < new Date()) {
      throw new Error("sso_code_invalid");
    }
    // Codes bound to an app only exchange with the same client_id.
    if (row.clientId && row.clientId !== clientId) {
      throw new Error("sso_code_invalid");
    }

    // Double-consume guard: mark consumed before returning identity.
    const updated = await this.prisma.ssoCode.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (updated.count === 0) throw new Error("sso_code_invalid");

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
}