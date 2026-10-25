import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { PidAppsService } from "../auth/apps.service";
import { PrismaService } from "../prisma/prisma.service";

/** App standing attached to the request by AppCredentialGuard (never a user session). */
export interface AuthedXpApp {
  id: string;
  clientId: string;
  ownerPid: string;
  isVerified: boolean;
  xpEnabled: boolean;
  approvedEventTypes: string[];
}

declare module "express" {
  interface Request {
    xpApp?: AuthedXpApp;
  }
}

/**
 * ANT-89 M3 (ANT-441) — dedicated server-to-server app-credential guard (Tobias C2).
 *
 * Verifies `client_id` + `client_secret` from the request body via
 * PidAppsService.clientSecretValid (peppered hash, rotation grace, expiry).
 * Fail-closed uniform 401 "Invalid client" for EVERY failure mode — unknown
 * app, inactive app, missing secret, expired secret, mismatch — so the
 * response never oracles which half was wrong and never carries secret
 * material (Tobias F5/F9).
 *
 * Hard differences from every other authenticated route:
 * - NEVER JwtAuthGuard and NEVER cookies: this guard reads no session, no
 *   bearer token, no `x-pid-scope`. A valid user/app JWT alone authenticates
 *   NOTHING here (locked by the C2 surface test next to app-token-surface).
 * - Missing secret fails closed even though clientSecretValid passes public
 *   (secret-less) clients elsewhere: intake REQUIRES a confidential client
 *   (C2 "fail closed on ... missing secret").
 * - isActive=false is rejected before any secret check (C2).
 *
 * Verified/XP-permission/approved-type checks are NOT done here — they are
 * pipeline predicates re-read on locked rows inside the award transaction
 * (Tobias F2), so revocation mid-flight still blocks the award.
 */
@Injectable()
export class AppCredentialGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly apps: PidAppsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ body?: Record<string, unknown>; xpApp?: AuthedXpApp }>();
    const body = req.body ?? {};
    const clientId = typeof body.client_id === "string" ? body.client_id : "";
    const secret = typeof body.client_secret === "string" ? body.client_secret : "";
    // Uniform failure: empty credentials are indistinguishable from wrong ones.
    if (!clientId || !secret) throw new UnauthorizedException("Invalid client");
    const app = await this.prisma.pidApp.findUnique({ where: { clientId } });
    if (!app || !app.isActive) throw new UnauthorizedException("Invalid client");
    // Intake requires a confidential client: no hash on record fails closed.
    if (!app.clientSecretHash) throw new UnauthorizedException("Invalid client");
    const ok = this.apps.clientSecretValid(
      {
        clientSecretHash: app.clientSecretHash,
        clientSecretExpiresAt: app.clientSecretExpiresAt,
        prevClientSecretHash: app.prevClientSecretHash,
        prevClientSecretExpiresAt: app.prevClientSecretExpiresAt,
      },
      secret,
    );
    if (!ok) throw new UnauthorizedException("Invalid client");
    req.xpApp = {
      id: app.id,
      clientId: app.clientId,
      ownerPid: app.ownerPid,
      isVerified: app.isVerified,
      xpEnabled: app.xpEnabled,
      approvedEventTypes: [...app.approvedEventTypes],
    };
    return true;
  }
}
