import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { RELIABLE_CHECKERS } from "./catalog";

export type CheckerName = (typeof RELIABLE_CHECKERS)[number];

export interface EvidenceVerdict {
  ok: boolean;
  /** Fail-closed reason (server-side only; clients get the generic envelope). */
  reason?: string;
}

/**
 * Narrow Prisma surface the checkers need (real client satisfies this; unit
 * tests fake it). All reads run on the award-transaction client.
 */
export interface EvidenceTx {
  identity: { findUnique(args: { where: { pid: string } }): Promise<{ status: string } | null> };
  profile: { findUnique(args: { where: { pid: string } }): Promise<{ pid: string } | null> };
  identityCredential: { count(args: { where: { pid: string } }): Promise<number> };
}

/**
 * ANT-89 M3 (ANT-441) — backend verification of reported activity (plan S4
 * step 5, R3 MVP catalog ONLY).
 *
 * Every checker validates against PeridotID-OWNED rows inside the award
 * transaction. Third-party-attested-only events (no PeridotID-side record
 * to check) are REJECTED — never awarded on an app's word alone:
 *
 * - internal_state.onboarding_completed → live Identity + Profile row
 *   (PeridotID-observed onboarding state; first-party verifiable).
 * - internal_state.identity_verified → live Identity + ≥1 linked credential
 *   (proofed via Google/email-OTP claim; PeridotID-observed).
 * - internal_state.campaign_verified → FAIL CLOSED: no campaign registry
 *   exists in M1/M2 (no PeridotID-side campaign record to check). Tasks may
 *   carry this checker (F8 registry membership passes) but intake rejects
 *   until a campaign store ships (follow-up for the CTO/parent).
 * - backend_check.achievement_owned → FAIL CLOSED: no PeridotID-issued
 *   achievement registry exists yet. Same follow-up.
 * - backend_check.activity_verified → FAIL CLOSED: no PeridotID-side
 *   activity-record linkage exists yet. Same follow-up.
 *
 * Fail-closed reasons stay server-side; the client envelope is the generic
 * `not_eligible` rejection (no oracle about which record was missing — F5).
 */
@Injectable()
export class EvidenceService {
  async verify(
    checker: string,
    input: { pid: string; resourceId?: string },
    tx: EvidenceTx | Prisma.TransactionClient,
  ): Promise<EvidenceVerdict> {
    const t = tx as EvidenceTx;
    switch (checker as CheckerName) {
      case "internal_state.onboarding_completed": {
        const identity = await t.identity.findUnique({ where: { pid: input.pid } });
        if (!identity || identity.status === "deleted") return { ok: false, reason: "no live identity" };
        const profile = await t.profile.findUnique({ where: { pid: input.pid } });
        if (!profile) return { ok: false, reason: "no profile row (onboarding incomplete)" };
        return { ok: true };
      }
      case "internal_state.identity_verified": {
        const identity = await t.identity.findUnique({ where: { pid: input.pid } });
        if (!identity || identity.status === "deleted") return { ok: false, reason: "no live identity" };
        const credentials = await t.identityCredential.count({ where: { pid: input.pid } });
        if (credentials < 1) return { ok: false, reason: "no linked credential (identity unverified)" };
        return { ok: true };
      }
      case "internal_state.campaign_verified":
        return { ok: false, reason: "no PeridotID-side campaign record (registry not shipped)" };
      case "backend_check.achievement_owned":
        return { ok: false, reason: "no PeridotID-issued achievement registry (not shipped)" };
      case "backend_check.activity_verified":
        return { ok: false, reason: "no PeridotID-side activity record linkage (not shipped)" };
      default:
        return { ok: false, reason: `unknown checker: ${checker}` };
    }
  }
}
