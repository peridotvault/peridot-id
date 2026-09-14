// Pending post-auth PID claims (Google-only entry point).
//
// A verified credential with no identity mints a single-use ticket (10-min TTL).
// The claim UI picks a handle; one transaction then creates identity + profile +
// credential and consumes the ticket. Nothing exists until claim, so abandoning
// restarts cleanly on the next login.
import { BadRequestException, ConflictException, GoneException, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { isPidHandle, normalizePidHandle, toPid } from "../common/pid";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import type { GoogleProfile } from "./auth.service";

const CLAIM_TTL_MS = 10 * 60 * 1000;

export interface ClaimTicketView {
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

function toView(row: { email: string | null; displayName: string | null; avatarUrl: string | null }): ClaimTicketView {
  return { email: row.email, displayName: row.displayName, avatarUrl: row.avatarUrl };
}

@Injectable()
export class ClaimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
  ) {}

  /** Mint a ticket from a verified Google profile (+ SSO targets). Returns the opaque id. */
  async mint(profile: GoogleProfile, opts?: { redirectTo?: string; clientId?: string }): Promise<string> {
    const id = `ct_${randomBytes(24).toString("base64url")}`;
    await this.prisma.claimTicket.create({
      data: {
        id,
        provider: "google",
        providerUserId: profile.id,
        email: profile.emails?.[0]?.value ?? null,
        displayName: profile.displayName ?? null,
        avatarUrl: profile.photos?.[0]?.value ?? null,
        redirectTo: opts?.redirectTo ?? null,
        clientId: opts?.clientId ?? null,
        expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
      },
    });
    return id;
  }

  /** Live ticket for the claim UI (null when none/expired/consumed). */
  async status(ticketId: string | undefined): Promise<ClaimTicketView | null> {
    if (!ticketId) return null;
    const row = await this.prisma.claimTicket.findUnique({ where: { id: ticketId } });
    if (!row || row.consumedAt || row.expiresAt < new Date()) return null;
    return toView(row);
  }

  /**
   * Claim the ticket's credential under a fresh handle: one transaction creates
   * identity + profile + credential and consumes the ticket. Returns the new pid.
   */
  async claim(ticketId: string, handle: string): Promise<{ pid: string; redirectTo: string | null; clientId?: string }> {
    const normalized = normalizePidHandle(handle ?? "");
    if (!isPidHandle(normalized)) {
      throw new BadRequestException(
        "Choose your permanent PID handle: 3-20 chars, lowercase letters, numbers, underscore. It can never be changed.",
      );
    }
    const pid = toPid(normalized);

    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.claimTicket.findUnique({ where: { id: ticketId } });
      if (!ticket || ticket.consumedAt || ticket.expiresAt < new Date()) {
        throw new GoneException("This claim expired — sign in again to get a fresh one.");
      }
      const taken = await tx.identity.findUnique({ where: { pid }, select: { pid: true } });
      if (taken) throw new ConflictException("PID already taken");

      // Same guards as direct sign-up: no second identity per credential or email.
      const existing = await tx.identityCredential.findUnique({
        where: { provider_providerUserId: { provider: ticket.provider, providerUserId: ticket.providerUserId } },
        select: { id: true },
      });
      if (existing) throw new ConflictException("This login is already linked to an account — sign in instead.");
      if (ticket.email) {
        const emailOwner = await tx.identityCredential.findFirst({ where: { email: ticket.email }, select: { id: true } });
        if (emailOwner) throw new ConflictException("Email is already linked to another account");
      }

      await tx.identity.create({ data: { pid, status: "active" } });
      await tx.profile.create({
        data: { pid, displayName: ticket.displayName, avatarUrl: ticket.avatarUrl },
      });
      await tx.identityCredential.create({
        data: {
          provider: ticket.provider,
          providerUserId: ticket.providerUserId,
          email: ticket.email,
          pid,
          lastLoginAt: new Date(),
        },
      });
      await tx.claimTicket.update({ where: { id: ticket.id }, data: { consumedAt: new Date() } });
      await this.security.log(pid, "identity.claimed", { provider: ticket.provider }, tx);
      return { pid, redirectTo: ticket.redirectTo, clientId: ticket.clientId ?? undefined };
    });
  }
}
