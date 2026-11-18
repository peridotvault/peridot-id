// Web3 usage metering (stage 5 of docs/plan/05-web3-mau.md).
//
// Counting rule (proposal, not agreed pricing): one PID counts once per
// registered app per UTC calendar month, after a successful app-bound
// external-wallet login. Everything else is unbilled by construction — only
// `walletVerify` with a resolved `clientId` writes an event.
//
// Reporting-only: reaching the allowance never charges and never blocks.
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { firstPartyOriginsFor } from "../common/cors";

/** Suggested allowance; env-overridable until pricing is agreed. */
export const DEFAULT_FREE_ALLOWANCE = 500;
export const USAGE_REASON_WALLET_LOGIN = "wallet_login";

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
  /** Distinct PIDs counted this month (all reasons). */
  activePids: number;
  /** Of those, logins classified first-party — never billable. */
  firstPartyPids: number;
  /** PIDs that would count against the allowance. */
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

  /** Configured free allowance per app per month (`PID_USAGE_FREE_ALLOWANCE`). */
  freeAllowance(): number {
    const raw = Number.parseInt(this.config.get<string>("PID_USAGE_FREE_ALLOWANCE", "") || "", 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_FREE_ALLOWANCE;
  }

  /**
   * Record one qualifying login. Never throws: metering must not fail a sign-in
   * the user already performed. Both writes are idempotent, so a retried or
   * concurrent verify collapses onto the same rows (and so does a second wallet
   * address proving the same PID).
   */
  async recordWalletLogin(appClientId: string, pid: string): Promise<void> {
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
          data: [{ appClientId, pid, month, reason: USAGE_REASON_WALLET_LOGIN, firstParty }],
          skipDuplicates: true,
        });
        // `update: {}` keeps the FIRST classification: replaying an old event
        // must not flip a PID's billability for a month already reported.
        await tx.usageMonthly.upsert({
          where: { appClientId_pid_month: { appClientId, pid, month } },
          create: { appClientId, pid, month, firstParty },
          update: {},
        });
      });
    } catch (err) {
      this.logger.warn(`usage not recorded for ${appClientId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Owner-scoped monthly report for one app. */
  async report(appClientId: string, month: string): Promise<UsageReport> {
    const [rows, firstPartyPids] = await Promise.all([
      this.prisma.usageMonthly.count({ where: { appClientId, month } }),
      this.prisma.usageMonthly.count({ where: { appClientId, month, firstParty: true } }),
    ]);
    const billablePids = rows - firstPartyPids;
    const freeAllowance = this.freeAllowance();
    return {
      appClientId,
      month,
      activePids: rows,
      firstPartyPids,
      billablePids,
      freeAllowance,
      overagePids: Math.max(0, billablePids - freeAllowance),
      billing: "reporting-only",
    };
  }
}
