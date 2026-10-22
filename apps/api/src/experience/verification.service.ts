import { Injectable } from "@nestjs/common";

export interface XpAppStanding {
  isActive: boolean;
  isVerified: boolean;
  xpEnabled: boolean;
  approvedEventTypes: string[];
}

export interface VerificationVerdict {
  /** Fail-closed: false for every unmet condition. */
  canSubmitEvents: boolean;
  reason?: string;
}

/**
 * ANT-89 M1 — XP submission permission model (fail-closed).
 *
 * Verification alone grants NOTHING: event intake (M3) requires the app to
 * be active AND verified AND explicitly XP-enabled AND the event type to be
 * on the admin-managed approved list. Losing Verified (or XP permission)
 * disables submissions immediately. Read API is unaffected — it is open to
 * all authorized apps including unverified ones.
 *
 * This service encodes the permission design under Tobias review (ANT-428);
 * the M3 intake pipeline calls it inside the award transaction.
 */
@Injectable()
export class VerificationService {
  canSubmitEvents(app: XpAppStanding | null | undefined, eventType?: string): VerificationVerdict {
    if (!app) return { canSubmitEvents: false, reason: "Unknown app" };
    if (!app.isActive) return { canSubmitEvents: false, reason: "App is not active" };
    if (!app.isVerified) return { canSubmitEvents: false, reason: "App is not Verified" };
    if (!app.xpEnabled) return { canSubmitEvents: false, reason: "App has no XP permission" };
    if (eventType !== undefined && !app.approvedEventTypes.includes(eventType)) {
      return { canSubmitEvents: false, reason: `Event type not approved: ${eventType}` };
    }
    return { canSubmitEvents: true };
  }
}
