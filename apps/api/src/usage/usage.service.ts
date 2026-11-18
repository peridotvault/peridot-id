// Web3 usage metering (stage 5 of docs/plan/05-web3-mau.md).
//
// Counting rule (agreed 2026-11-18): a PID counts once per registered app per
// UTC calendar month. A PID is global, so the same PID counts separately in two
// apps; repeat logins, extra linked wallets and mixed login methods never add to
// a month's count. Existing and newly claimed PIDs are treated identically.
//
// Two numbers per app/month, never blended:
//   total MAU  — every PID that completed an app-bound login (Web2 or wallet)
//   Web3 MAU   — the subset that proved an external wallet; the free allowance
//                and the reported overage apply to THIS number only.
// Web2-only usage is unlimited and free.
//
// Reporting-only: reaching the allowance never charges and never blocks.
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { firstPartyOriginsFor } from "../common/cors";

/** Suggested allowance; env-overridable until pricing is agreed. */
export const DEFAULT_FREE_ALLOWANCE = 500;
/** Qualifying Web3 event: the PID proved an external wallet for this app. */
export const USAGE_REASON_WALLET_LOGIN = "wallet_login";
/** Total-MAU event: any other app-bound login (Google, email OTP, passkey). */
export const USAGE_REASON_APP_LOGIN = "app_login";

/** `YYYY-MM` in UTC — the billing boundary is UTC, never the caller's zone. */
export function utcMonth(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Server-side first-party check. Only operator-controlled origins count, so an
 * app cannot exempt itself by claiming to be first-party: the value comes from
 * the stored app row plus the server's own origin list.
 */
export function isFirstPartyApp(allowedOrigins: readonly string[], firstPartyOrigins: readonly string[]): boolean {
  if (allowedOrigins.length === 0) return false;
  return allowedOrigins.every((origin) => firstPartyOrigins.includes(origin.replace(/\/+$/, "")));
}

export interface UsageReport {
  appClientId: string;
  month: string;
  /** Total MAU: distinct PIDs with any app-bound login this month. */
  totalPids: number;
  /** Web3 MAU: distinct PIDs that proved an external wallet this month. */
  web3Pids: number;
  /** Of the Web3 MAU, logins classified first-party — never billable. */
  firstPartyPids: number;
  /** Web3 PIDs that would count against the allowance. */
  billablePids: number;
  freeAllowance: number;
  /** Reported only. Nothing is charged and nothing is blocked. */
  overagePids: number;
  billing: "reporting-only";
}

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Called only after a successful SSO exchange. Never creates a global-user listing. */
  async recordSuccessfulLogin(appClientId: string, pid: string): Promise<void> {
    try {
      const at = new Date();
      // Atomic upsert; GREATEST prevents a slower concurrent login moving time backwards.
      await this.prisma.$executeRaw`
        INSERT INTO app_users ("appClientId", pid, "firstLoginAt", "lastLoginAt")
        VALUES (${appClientId}, ${pid}, ${at}, ${at})
        ON CONFLICT ("appClientId", pid) DO UPDATE
        SET "firstLoginAt" = LEAST(app_users."firstLoginAt", EXCLUDED."firstLoginAt"),
            "lastLoginAt" = GREATEST(app_users."lastLoginAt", EXCLUDED."lastLoginAt")`;
    } catch (err) {
      this.logger.warn(`App user login history unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Configured free allowance per app per month (`PID_USAGE_FREE_ALLOWANCE`). */
  freeAllowance(): number {
    const raw = Number.parseInt(this.config.get<string>("PID_USAGE_FREE_ALLOWANCE", "") || "", 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_FREE_ALLOWANCE;
  }

  /** A PID proved an external wallet for this app — counts as Web3 MAU. */
  async recordWalletLogin(appClientId: string, pid: string): Promise<void> {
    await this.record(appClientId, pid, USAGE_REASON_WALLET_LOGIN, true);
  }

  /** Any other app-bound login — counts toward total MAU only. */
  async recordAppLogin(appClientId: string, pid: string): Promise<void> {
    await this.record(appClientId, pid, USAGE_REASON_APP_LOGIN, false);
  }

  /**
   * Never throws: metering must not fail a sign-in the user already performed.
   * Both writes are idempotent, so a retried or concurrent login collapses onto
   * the same rows, and the projection never adds a PID twice.
   */
  private async record(appClientId: string, pid: string, reason: string, web3: boolean): Promise<void> {
    try {
      const app = await this.prisma.pidApp.findUnique({
        where: { clientId: appClientId },
        select: { allowedOrigins: true },
      });
      // Unregistered app: cannot be attributed, so it is never counted.
      if (!app) return;
      const month = utcMonth();
      const firstParty = isFirstPartyApp(app.allowedOrigins, firstPartyOriginsFor(this.config));
      await this.prisma.$transaction(async (tx) => {
        await tx.usageEvent.createMany({
          data: [{ appClientId, pid, month, reason, firstParty }],
          skipDuplicates: true,
        });
        // `update` only ever upgrades web3 false→true and keeps the FIRST
        // classification: replaying an old event must not flip a PID's
        // billability, and a later wallet login must not create a second row.
        await tx.usageMonthly.upsert({
          where: { appClientId_pid_month: { appClientId, pid, month } },
          create: { appClientId, pid, month, web3, firstParty },
          update: web3 ? { web3: true } : {},
        });
      });
    } catch (err) {
      this.logger.warn(`usage not recorded for ${appClientId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Owner-scoped monthly report for one app. */
  async report(appClientId: string, month: string): Promise<UsageReport> {
    const where = { appClientId, month };
    const [totalPids, web3Pids, firstPartyPids] = await Promise.all([
      this.prisma.usageMonthly.count({ where }),
      this.prisma.usageMonthly.count({ where: { ...where, web3: true } }),
      this.prisma.usageMonthly.count({ where: { ...where, web3: true, firstParty: true } }),
    ]);
    const billablePids = web3Pids - firstPartyPids;
    const freeAllowance = this.freeAllowance();
    return {
      appClientId,
      month,
      totalPids,
      web3Pids,
      firstPartyPids,
      billablePids,
      freeAllowance,
      overagePids: Math.max(0, billablePids - freeAllowance),
      billing: "reporting-only",
    };
  }
}
