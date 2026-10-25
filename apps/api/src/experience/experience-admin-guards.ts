import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { PrismaService } from "../prisma/prisma.service";
import { SECOND_PERSON_MIN_REASON } from "./experience-admin.dto";

/**
 * F3 grant envelope verdict (pure — unit tested without a DB).
 *
 * Raises/grants require second-person confirm (a DIFFERENT admin) OR a
 * mandatory justification (>= 10 chars). Non-raises (disables, cap lowers,
 * narrows) need no envelope but are still audited by the caller.
 */
export function checkGrantEnvelope(input: {
  isRaise: boolean;
  actorAdminId: string;
  confirmedBy?: string;
  reason?: string;
}): { ok: true } | { ok: false; error: string } {
  if (!input.isRaise) return { ok: true };
  const confirmedBy = (input.confirmedBy ?? "").trim();
  const reason = (input.reason ?? "").trim();
  if (confirmedBy) {
    if (confirmedBy.toLowerCase() === input.actorAdminId.toLowerCase()) {
      return { ok: false, error: "confirmedBy must be a different admin (self-confirm is not second-person)" };
    }
    return { ok: true };
  }
  if (reason.length >= SECOND_PERSON_MIN_REASON) return { ok: true };
  return {
    ok: false,
    error: `permission grants require second-person confirm (confirmedBy) or justification (reason >= ${SECOND_PERSON_MIN_REASON} chars)`,
  };
}

export async function requireApp(prisma: PrismaService, appId: string) {
  const app = await prisma.pidApp.findUnique({ where: { id: appId } });
  if (!app) throw new NotFoundException("scope app not found");
  return app;
}

export async function requireActiveAdmin(prisma: PrismaService, pid: string) {
  const identity = await prisma.identity.findUnique({ where: { pid: pid.toLowerCase() } });
  if (!identity || identity.status !== "active" || identity.role !== "admin") {
    throw new BadRequestException("confirmedBy must be an active admin");
  }
  return identity;
}
