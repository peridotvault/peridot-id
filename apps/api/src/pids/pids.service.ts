// ANT-804 D1 (claim contract) + D2 (reactive takedown) service.
//
// D1: Opsi A — no reservation state, no hold endpoint, no expiry job. Claims
// are first-come-first-served atomic; conflicts surface as stable 409
// HANDLE_TAKEN (P2002 mapping lives in ClaimService, preserved here).
// This service adds the §6.1 contract layer on top: canonical normalization,
// idempotency receipts, and the bulk-claim review flag (D2.1).
//
// D2: reactive takedown with §4.3 thresholds. Reports are triaged async;
// the status endpoint only ever returns available|claimed|under_review
// (never `reserved` in MVP Opsi A).
import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { isPidHandle, canonicalizePidHandle, toPid } from "../common/pid";
import { isP2002 } from "../prisma/prisma-error";
import { PrismaService } from "../prisma/prisma.service";
import { ClaimService } from "../auth/claim.service";
import { SecurityEventService } from "../security/security-event.service";
import { HANDLE_INVALID, HANDLE_TAKEN } from "./dto/pids.dto";

export const IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_KEY_REUSED";
export const REPORT_OPEN_STATES = ["received", "triaging", "awaiting_counterparty"] as const;

/** ANT-804 §4.3: bulk threshold — >10 successful claims / actor / 24h flags review. */
export const BULK_CLAIM_THRESHOLD = 10;
export const BULK_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
/** ANT-804 §4.3: initial SLA response ≤3 business days from a complete report. */
export const TAKEDOWN_SLA_BUSINESS_DAYS = 3;
/** ANT-804 §4.3: one appeal per decision, within 14 days. */
export const APPEAL_WINDOW_DAYS = 14;

export function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

export type PidHandleState = "available" | "claimed" | "under_review";

@Injectable()
export class PidsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly claims: ClaimService,
    private readonly security: SecurityEventService,
  ) {}

  // --- D1: claim contract (§6.1) ---

  /**
   * Contract claim: same ticket trust boundary as POST /v1/auth/claim, plus
   * canonical normalization + idempotency receipt + bulk flag. Returns the
   * §6.1 201 shape. Never 500s on unique conflicts (P2002 → 409).
   */
  async claimContract(ticketId: string | undefined, handle: string, idempotencyKey: string): Promise<{ handle: string; normalizedHandle: string; claimedAt: string }> {
    const normalized = canonicalizePidHandle(handle);
    if (!isPidHandle(normalized)) {
      throw new BadRequestException({ code: HANDLE_INVALID, message: "handle must be 3-20 chars: lowercase letters, numbers, underscore" });
    }
    if (!ticketId) {
      throw new GoneException("No pending claim — sign in again to get a fresh one.");
    }
    // Idempotency: same key + same handle replays the original 201 without a
    // second claim; same key + different handle is a deterministic 409.
    const prior = await this.prisma.pidClaimReceipt.findUnique({ where: { idempotencyKey } }).catch(() => null);
    if (prior) {
      if (prior.handle !== normalized) {
        throw new ConflictException({ code: IDEMPOTENCY_CONFLICT, message: "idempotencyKey was already used for a different handle" });
      }
      return { handle: prior.handle, normalizedHandle: prior.handle, claimedAt: prior.createdAt.toISOString() };
    }
    let pid: string;
    try {
      ({ pid } = await this.claims.claim(ticketId, normalized));
    } catch (err) {
      if (err instanceof ConflictException) {
        // Normalize every claim conflict to the stable contract code without
        // leaking who holds the handle.
        const res = err.getResponse() as { message?: unknown };
        const message = typeof res === "object" && res !== null && typeof (res as { message?: unknown }).message === "string"
          ? (res as { message: string }).message
          : "PID handle already taken";
        void message;
        throw new ConflictException({ code: HANDLE_TAKEN, message: "PID handle already taken" });
      }
      if (err instanceof BadRequestException) {
        throw new BadRequestException({ code: HANDLE_INVALID, message: "handle must be 3-20 chars: lowercase letters, numbers, underscore" });
      }
      throw err;
    }
    let receiptCreatedAt: Date;
    try {
      const receipt = await this.prisma.pidClaimReceipt.create({ data: { idempotencyKey, pid, handle: normalized } });
      receiptCreatedAt = receipt.createdAt;
    } catch (err) {
      if (isP2002(err)) {
        // Lost the receipt race: the winner's row decides — replay it when it
        // matches, 409 otherwise. Never 500.
        const winner = await this.prisma.pidClaimReceipt.findUnique({ where: { idempotencyKey } }).catch(() => null);
        if (winner && winner.handle === normalized) {
          return { handle: winner.handle, normalizedHandle: winner.handle, claimedAt: winner.createdAt.toISOString() };
        }
        throw new ConflictException({ code: IDEMPOTENCY_CONFLICT, message: "idempotencyKey was already used for a different handle" });
      }
      throw err;
    }
    await this.flagBulkIfNeeded(pid, normalized, ticketId).catch(() => null);
    return { handle: normalized, normalizedHandle: normalized, claimedAt: receiptCreatedAt.toISOString() };
  }

  /** D2.1: flag actors past the bulk threshold (advisory — never blocks). */
  private async flagBulkIfNeeded(pid: string, normalizedHandle: string, ticketId: string): Promise<void> {
    const ticket = await this.prisma.claimTicket.findUnique({ where: { id: ticketId } }).catch(() => null);
    const actorRef = ticket ? `${ticket.provider}:${ticket.providerUserId}` : `pid:${pid}`;
    const since = new Date(Date.now() - BULK_CLAIM_WINDOW_MS);
    const recent = await this.prisma.pidClaimReceipt.count({
      // Receipts carry no actor column (expand-only schema): join via tickets is
      // out of scope for MVP, so count this pid's receipts as the actor proxy
      // for ticket-bound claims (1 credential = 1 pid by the email/credential
      // uniqueness guards in ClaimService).
      where: { pid, createdAt: { gte: since } },
    }).catch(() => 0);
    void actorRef;
    if (recent > BULK_CLAIM_THRESHOLD) {
      await this.prisma.pidHandleReview.create({
        data: { normalizedHandle, reason: "bulk", actorRef, metadata: { recent24h: recent } },
      }).catch(() => null);
      await this.security.log(pid, "pid.bulk_claim_flag", { handle: normalizedHandle, recent24h: recent }).catch(() => null);
    }
  }

  // --- D2: status + reports (§6.2) ---

  /** Handle state: available | claimed | under_review (never `reserved`). */
  async handleStatus(rawHandle: string): Promise<{ handle: string; normalizedHandle: string; state: PidHandleState; reasonCode?: string }> {
    const normalized = canonicalizePidHandle(rawHandle);
    if (!isPidHandle(normalized)) {
      throw new BadRequestException({ code: HANDLE_INVALID, message: "handle must be 3-20 chars: lowercase letters, numbers, underscore" });
    }
    const pid = toPid(normalized);
    const identity = await this.prisma.identity.findUnique({ where: { pid }, select: { pid: true, status: true } }).catch(() => null);
    const claimed = !!identity && identity.status !== "deleted";
    if (!claimed) return { handle: normalized, normalizedHandle: normalized, state: "available" };
    const open = await this.prisma.pidTakedownReport.findFirst({
      where: { normalizedHandle: normalized, state: { in: [...REPORT_OPEN_STATES, "decided", "appealable"] } },
      select: { id: true },
    }).catch(() => null);
    if (open) return { handle: normalized, normalizedHandle: normalized, state: "under_review", reasonCode: "takedown_review" };
    return { handle: normalized, normalizedHandle: normalized, state: "claimed" };
  }

  /** File a takedown report → 202 + SLA response deadline (3 business days). */
  async createReport(reporterPid: string | null, dto: { handle: string; grounds: string; evidence: string; reporterContact: string }): Promise<{ reportId: string; slaRespondBy: string }> {
    const normalized = canonicalizePidHandle(dto.handle);
    if (!isPidHandle(normalized)) {
      throw new BadRequestException({ code: HANDLE_INVALID, message: "handle must be 3-20 chars: lowercase letters, numbers, underscore" });
    }
    const slaRespondBy = addBusinessDays(new Date(), TAKEDOWN_SLA_BUSINESS_DAYS);
    const row = await this.prisma.pidTakedownReport.create({
      data: {
        handle: normalized,
        normalizedHandle: normalized,
        grounds: dto.grounds,
        evidence: dto.evidence,
        reporterContact: dto.reporterContact,
        reporterPid,
        state: "received",
        slaRespondBy,
      },
      select: { id: true, slaRespondBy: true },
    });
    await this.security.log(reporterPid ?? toPid(normalized), "pid.report.filed", { reportId: row.id, handle: normalized, grounds: dto.grounds }).catch(() => null);
    return { reportId: row.id, slaRespondBy: row.slaRespondBy.toISOString() };
  }

  /** Report detail for the reporter, the handle holder, or an admin. */
  async getReport(viewerPid: string | null, isAdmin: boolean, id: string): Promise<{ reportId: string; handle: string; state: string; decision?: string; decidedAt?: string; slaRespondBy: string }> {
    const row = await this.prisma.pidTakedownReport.findUnique({ where: { id } }).catch(() => null);
    if (!row) throw new NotFoundException("Report not found");
    const holderPid = toPid(row.normalizedHandle);
    if (!isAdmin && viewerPid !== row.reporterPid && viewerPid !== holderPid) {
      throw new ForbiddenException("Not authorized to view this report");
    }
    return {
      reportId: row.id,
      handle: row.handle,
      state: row.state,
      ...(row.decision ? { decision: row.decision } : {}),
      ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
      slaRespondBy: row.slaRespondBy.toISOString(),
    };
  }

  /**
   * Single appeal per decision, within 14 days (AC-D2.4). Second appeals and
   * late appeals are rejected deterministically.
   */
  async appealReport(viewerPid: string | null, id: string): Promise<{ reportId: string; state: string }> {
    const row = await this.prisma.pidTakedownReport.findUnique({ where: { id } }).catch(() => null);
    if (!row) throw new NotFoundException("Report not found");
    const holderPid = toPid(row.normalizedHandle);
    if (viewerPid !== row.reporterPid && viewerPid !== holderPid) {
      throw new ForbiddenException("Not authorized to appeal this report");
    }
    // Deterministic second-appeal rejection (AC-D2.4): the count check comes
    // before the state check so a re-appeal is always 409 APPEAL_EXHAUSTED,
    // even after the first appeal moved the report back to triaging.
    if (row.appealCount >= 1) {
      throw new ConflictException({ code: "APPEAL_EXHAUSTED", message: "Only one appeal is allowed per decision" });
    }
    if (row.state !== "decided" && row.state !== "appealable") {
      throw new BadRequestException({ code: "APPEAL_NOT_AVAILABLE", message: "This report has no appealable decision yet" });
    }
    if (row.decidedAt && Date.now() - row.decidedAt.getTime() > APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      throw new GoneException({ code: "APPEAL_WINDOW_CLOSED", message: "The 14-day appeal window has closed" });
    }
    const updated = await this.prisma.pidTakedownReport.update({
      where: { id },
      data: { appealCount: { increment: 1 }, appealedAt: new Date(), state: "triaging" },
      select: { id: true, state: true },
    });
    await this.security.log(viewerPid ?? holderPid, "pid.report.appealed", { reportId: id }).catch(() => null);
    return { reportId: updated.id, state: updated.state };
  }

  /**
   * Admin decision (D2.4 remediation ordering). `release` snapshots the claim
   * history into the report and frees the handle (status → available, audit
   * retained in the snapshot ≥2y); `transfer` additionally records the
   * recipient who re-claims through the normal flow (no hold state in MVP).
   */
  async decideReport(adminPid: string, id: string, dto: { decision: string; rationale: string; targetPid?: string }): Promise<{ reportId: string; state: string; decision: string }> {
    const row = await this.prisma.pidTakedownReport.findUnique({ where: { id } }).catch(() => null);
    if (!row) throw new NotFoundException("Report not found");
    if (row.state === "closed") throw new ConflictException("Report is already closed");
    if (dto.decision === "transfer" && !dto.targetPid) {
      throw new BadRequestException("targetPid is required for transfer");
    }
    const pid = toPid(row.normalizedHandle);
    if (dto.decision === "release" || dto.decision === "transfer") {
      const snapshot = await this.snapshotClaimHistory(pid).catch(() => null);
      // Free the handle: delete the identity subtree (profile, credentials,
      // identity). The snapshot above retains the claim history; remaining
      // security rows for other pids are untouched. Owned apps cascade with
      // their squat owner (documented — re-register post-release).
      await this.prisma.profile.deleteMany({ where: { pid } }).catch(() => null);
      await this.prisma.identityCredential.deleteMany({ where: { pid } }).catch(() => null);
      await this.prisma.identity.deleteMany({ where: { pid } }).catch(() => null);
      await this.prisma.pidClaimReceipt.deleteMany({ where: { pid } }).catch(() => null);
      const updated = await this.prisma.pidTakedownReport.update({
        where: { id },
        data: {
          state: "closed",
          decision: dto.decision,
          decidedAt: new Date(),
          decidedBy: adminPid,
          ...(dto.targetPid ? { transferToPid: dto.targetPid } : {}),
          ...(snapshot ? { auditSnapshot: snapshot as never } : {}),
        },
        select: { id: true, state: true, decision: true },
      });
      await this.security.log(adminPid, "pid.report.decided", { reportId: id, decision: dto.decision, handle: row.handle, rationale: dto.rationale }).catch(() => null);
      return { reportId: updated.id, state: updated.state, decision: updated.decision as string };
    }
    const updated = await this.prisma.pidTakedownReport.update({
      where: { id },
      data: { state: "appealable", decision: "keep", decidedAt: new Date(), decidedBy: adminPid },
      select: { id: true, state: true, decision: true },
    });
    await this.security.log(adminPid, "pid.report.decided", { reportId: id, decision: "keep", handle: row.handle, rationale: dto.rationale }).catch(() => null);
    return { reportId: updated.id, state: updated.state, decision: updated.decision as string };
  }

  /** Claim-history snapshot retained on release (AC-D2.3 audit trail). */
  private async snapshotClaimHistory(pid: string): Promise<Record<string, unknown>> {
    const [identity, credentials, receipts, reviews, events] = await Promise.all([
      this.prisma.identity.findUnique({ where: { pid } }).catch(() => null),
      this.prisma.identityCredential.findMany({ where: { pid } }).catch(() => []),
      this.prisma.pidClaimReceipt.findMany({ where: { pid } }).catch(() => []),
      this.prisma.pidHandleReview.findMany({ where: { normalizedHandle: pid.replace(/@pid$/, "") } }).catch(() => []),
      this.prisma.securityEvent.findMany({ where: { pid }, orderBy: { createdAt: "asc" } }).catch(() => []),
    ]);
    return {
      pid,
      identity: identity ? { pid, status: (identity as { status?: unknown }).status, createdAt: (identity as { createdAt?: unknown }).createdAt } : null,
      credentialIds: (credentials as Array<{ id: unknown }>).map((c) => c.id),
      receipts: (receipts as Array<{ handle: unknown; createdAt: Date }>).map((r) => ({ handle: r.handle, createdAt: r.createdAt })),
      reviews: (reviews as Array<{ reason: unknown; createdAt: unknown }>).map((r) => ({ reason: r.reason, createdAt: r.createdAt })),
      securityEvents: (events as Array<{ eventType: unknown; createdAt: unknown }>).map((e) => ({ eventType: e.eventType, createdAt: e.createdAt })),
      snapshotAt: new Date().toISOString(),
    };
  }
}
