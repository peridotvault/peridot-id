// Self-serve OAuth client registry ("Sign in with PeridotID"). Any logged-in identity
// can register an app and get a public client_id; PeridotID only returns pid_codes to
// the app's registered redirect URIs. CORS origins are derived from those URIs.

import { Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

export function originsOf(redirectUris: string[]): string[] {
  const origins = new Set<string>();
  for (const uri of redirectUris) {
    try {
      origins.add(new URL(uri).origin);
    } catch {
      // validated upstream; skip defensively
    }
  }
  return [...origins];
}

@Injectable()
export class PidAppsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, name: string, redirectUris: string[]) {
    const clientId = `pidapp_${randomBytes(16).toString("hex")}`;
    return this.prisma.pidApp.create({
      data: { clientId, ownerId, name, redirectUris, allowedOrigins: originsOf(redirectUris) },
    });
  }

  async list(ownerId: string) {
    return this.prisma.pidApp.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" } });
  }

  async update(ownerId: string, id: string, patch: { name?: string; redirectUris?: string[]; isActive?: boolean }) {
    const app = await this.prisma.pidApp.findFirst({ where: { id, ownerId } });
    if (!app) throw new NotFoundException("App not found");
    return this.prisma.pidApp.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.redirectUris !== undefined
          ? { redirectUris: patch.redirectUris, allowedOrigins: originsOf(patch.redirectUris) }
          : {}),
        ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      },
    });
  }

  /** Active app by client_id (null when unknown/disabled) — used by the SSO checks. */
  async findActive(clientId: string) {
    const app = await this.prisma.pidApp.findUnique({ where: { clientId } });
    return app && app.isActive ? app : null;
  }
}
