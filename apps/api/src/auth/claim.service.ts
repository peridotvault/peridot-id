// Pending post-auth PID claims (Google + email-OTP entry points).
//
// A verified credential with no identity mints a single-use ticket (10-min TTL).
// The claim UI picks a handle; one transaction then creates identity + profile +
// credential and consumes the ticket. Nothing exists until claim, so abandoning
// restarts cleanly on the next login.
import { BadRequestException, ConflictException, GoneException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "node:crypto";
import { isPidHandle, normalizePidHandle, toPid } from "../common/pid";
import { isP2002 } from "../prisma/prisma-error";
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
    private readonly config: ConfigService,
  ) {}

  /**
   * Ops bootstrap: PIDs in `PID_BOOTSTRAP_ADMIN_PID` (comma-separated, e.g.
   * `ifal@pid`) are created with the `admin` role when claimed. Env-driven, never
   * hardcoded; an already-existing identity is never changed here (promote via
   * the documented SQL/`admin:promote` instead).
   *
   * ONE-TIME (ANT-227 item 2): the bootstrap grant applies only while NO admin
   * exists yet — the first bootstrap claim creates the first admin, every later
   * claim (even a bootstrap PID) is a plain user. Re-login can therefore never
   * escalate. Remove the env var after bootstrap; the API logs a startup
   * warning while it is set (see main.ts).
   */
  private isBootstrapAdmin(pid: string): boolean {
    const raw = this.config.get<string>("PID_BOOTSTRAP_ADMIN_PID", "") || "";
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(pid.toLowerCase());
  }

  /**
   * Mint a ticket from a verified Google profile (+ SSO targets). The verified-
   * email gate lives HERE (M4), not just in the strategy: mint() is the trust
   * boundary where an unverified address must never become a claim ticket.
   * Throws 400 when the profile carries no verified email.
   */
  async mint(profile: GoogleProfile, opts?: { redirectTo?: string; clientId?: string }): Promise<string> {
    const firstEmail = profile.emails?.[0];
    const email = firstEmail?.value ?? null;
    if (!email || firstEmail?.verified !== true) {
      throw new BadRequestException(
        "Google account email is not verified — verify it with Google and sign in again.",
      );
    }
    return this.mintCredential(
      { provider: "google", providerUserId: profile.id, email },
      { displayName: profile.displayName ?? null, avatarUrl: profile.photos?.[0]?.value ?? null },
      opts,
    );
  }

  /** Mint a ticket from any verified credential (email-OTP uses provider "email"). */
  async mintCredential(
    credential: { provider: string; providerUserId: string; email: string | null },
    profile?: { displayName?: string | null; avatarUrl?: string | null },
    opts?: { redirectTo?: string; clientId?: string },
  ): Promise<string> {
    const id = `ct_${randomBytes(24).toString("base64url")}`;
    await this.prisma.claimTicket.create({
      data: {
        id,
        provider: credential.provider,
        providerUserId: credential.providerUserId,
        email: credential.email,
        displayName: profile?.displayName ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        redirectTo: opts?.redirectTo ?? null,
        clientId: opts?.clientId ?? null,
        expiresAt: new Date(Date.now() + CLAIM_TTL_MS),
      },
    });
    return id;
  }

  /** Abandon a pending claim: consume the ticket so it can never be picked up
   *  later. Idempotent — missing/consumed/expired tickets are still OK. */
  async abandon(ticketId: string | undefined): Promise<void> {
    if (!ticketId) return;
    await this.prisma.claimTicket.updateMany({
      where: { id: ticketId, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
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
  async claim(ticketId: string, handle: string): Promise<{ pid: string; redirectTo: string | null; clientId?: string; provider: string }> {
    const normalized = normalizePidHandle(handle ?? "");
    if (!isPidHandle(normalized)) {
      throw new BadRequestException(
        "Choose your permanent PID handle: 3-20 chars, lowercase letters, numbers, underscore. It can never be changed.",
      );
    }
    const pid = toPid(normalized);

    // Unique-race mapping (ANT-233 F3): the pre-checks above run under
    // read-committed, so two concurrent claims (same pid, same credential,
    // or case-variant email) can both pass them. The DB's unique indexes
    // (PK, provider+providerUserId, lower(email)) make exactly one winner;
    // the loser's P2002 surfaces here as 409, never 500.
    try {
      return await this.prisma.$transaction(async (tx) => {
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
        // Case-insensitive (ANT-227 item 3): must match findIdentityByEmail or
        // a case-variant email mints a second identity and breaks the global
        // email index (409 here instead of a 500 there).
        const emailOwner = await tx.identityCredential.findFirst({
          where: { email: { equals: ticket.email, mode: "insensitive" } },
          select: { id: true },
        });
        if (emailOwner) throw new ConflictException("Email is already linked to another account");
      }

      // Bootstrap is one-time (ANT-227 item 2): only when no admin exists yet.
      // After the first admin, bootstrap PIDs claim as plain users — re-login
      // (or a second claim) can never escalate.
      // Singleton-lock serialization (ANT-233 F4): the admin check above runs
      // under read-committed, so two concurrent bootstrap claims can both see
      // "no admin" and both mint admins. The lock insert admits exactly one
      // winner per transaction — the loser gets P2002 and claims as a user.
      let role: "admin" | "user" = "user";
      if (this.isBootstrapAdmin(pid)) {
        const adminExists = await tx.identity.findFirst({ where: { role: "admin" }, select: { pid: true } });
        if (!adminExists) {
          try {
            await tx.bootstrapAdminLock.create({ data: { id: "bootstrap-admin", pid } });
            role = "admin";
          } catch (err) {
            if (!isP2002(err)) throw err;
            role = "user";
          }
        }
      }

      await tx.identity.create({ data: { pid, status: "active", role } });
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
      return { pid, redirectTo: ticket.redirectTo, clientId: ticket.clientId ?? undefined, provider: ticket.provider };
      });
    } catch (err) {
      if (isP2002(err)) throw new ConflictException("This login was just claimed — sign in instead.");
      throw err;
    }
  }
}
