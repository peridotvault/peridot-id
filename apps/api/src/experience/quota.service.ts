import { Injectable } from "@nestjs/common";

/** Admin-configured caps; null/undefined = unbounded. Never hardcoded. */
export interface CapSet {
  dailyCap?: number | null;
  weeklyCap?: number | null;
  monthlyCap?: number | null;
}

export interface QuotaInput {
  /** XP already credited in each window (ledger sums locked in the award txn, R2). */
  periodSums: { daily: number; weekly: number; monthly: number };
  /** XP this award would add. */
  deltaXp: number;
  caps: CapSet;
  suspended?: boolean;
  suspendReason?: string | null;
}

export interface QuotaVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * ANT-89 M1 — quota evaluation (pure; M3 wires it into the award
 * transaction against locked period sums from ledger rows).
 *
 * Units tested here gate the M1 quota-service code (R2); the race tests
 * (parallel distinct events over a cap credit ≤ cap) gate the M3 pipeline
 * that calls this inside the locked txn.
 */
@Injectable()
export class QuotaService {
  evaluate(input: QuotaInput): QuotaVerdict {
    if (input.suspended) {
      return { allowed: false, reason: input.suspendReason ?? "App XP awards suspended" };
    }
    const { daily, weekly, monthly } = input.periodSums;
    for (const v of [daily, weekly, monthly, input.deltaXp]) {
      if (!Number.isFinite(v) || v < 0) return { allowed: false, reason: "Invalid quota accounting input" };
    }
    const checks: Array<[number | null | undefined, number, string]> = [
      [input.caps.dailyCap, daily, "daily"],
      [input.caps.weeklyCap, weekly, "weekly"],
      [input.caps.monthlyCap, monthly, "monthly"],
    ];
    for (const [cap, sum, name] of checks) {
      if (cap != null && sum + input.deltaXp > cap) {
        return { allowed: false, reason: `${name} cap exceeded (${sum}+${input.deltaXp} > ${cap})` };
      }
    }
    return { allowed: true };
  }
}
