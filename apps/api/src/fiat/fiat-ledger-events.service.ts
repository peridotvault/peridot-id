import { createHmac } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { decryptSecret } from "../common/secret-crypto";

/** Third-party callback outbox: enqueue (via ledger writes) + cron delivery. */
@Injectable()
export class FiatLedgerEventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Deliver due callback events (cron-driven), HMAC-SHA256 signed with the
   * target app's webhook secret (`X-Pid-Signature: sha256=<hex>`). Failures
   * retry with backoff up to 6 attempts, then stay `failed` for admin review.
   */
  async dispatchEvents(input: { take?: number }): Promise<{ sent: number; failed: number; pending: number }> {
    const take = Math.min(Math.max(input.take ?? 20, 1), 100);
    const due = await this.prisma.fiatLedgerEvent.findMany({
      where: { status: "pending", nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take,
    });
    let sent = 0;
    let failed = 0;
    for (const ev of due) {
      // Resolve the secret for the exact app this event targets (owner + URL),
      // not just the first active app under the owner. A missing/inactive app
      // or secret is fail-closed: never dispatch with an empty-key HMAC —
      // record and retry with backoff like any delivery failure. ANT-286a:
      // the stored value is an `enc:v1:` envelope — decrypt server-side with
      // PID_SECRETS_ENC_KEY; missing/undecryptable = failNoSecret.
      const app = await this.prisma.pidApp.findFirst({
        where: { ownerPid: ev.targetPid, webhookUrl: ev.targetUrl, isActive: true },
        select: { webhookSecret: true },
      });
      const failNoSecret = async (reason: string) => {
        const attempts = ev.attempts + 1;
        const dead = attempts >= 6;
        const backoffMs = Math.min(3_600_000, 1000 * 2 ** attempts);
        await this.prisma.fiatLedgerEvent.update({
          where: { id: ev.id },
          data: { status: dead ? "failed" : "pending", attempts, nextAttemptAt: new Date(Date.now() + backoffMs), lastError: reason.slice(0, 200) },
        });
        failed++;
      };
      let rawSecret: string | null = null;
      try {
        const key = this.config.get<string>("PID_SECRETS_ENC_KEY", "") || undefined;
        rawSecret = decryptSecret(app?.webhookSecret ?? null, key);
      } catch {
        rawSecret = null;
      }
      if (!rawSecret) {
        await failNoSecret("webhook app missing, inactive, or secret undecryptable — refusing unsigned dispatch");
        continue;
      }
      const body = JSON.stringify(ev.payload);
      const sig = "sha256=" + createHmac("sha256", rawSecret).update(body).digest("hex");
      try {
        const res = await fetch(ev.targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Pid-Event": ev.eventType, "X-Pid-Signature": sig },
          body,
          // Bound delivery so a hung endpoint can't stall the dispatcher.
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await this.prisma.fiatLedgerEvent.update({ where: { id: ev.id }, data: { status: "delivered", deliveredAt: new Date(), attempts: ev.attempts + 1, lastError: null } });
        sent++;
      } catch (err) {
        const attempts = ev.attempts + 1;
        const dead = attempts >= 6;
        const backoffMs = Math.min(3_600_000, 1000 * 2 ** attempts);
        await this.prisma.fiatLedgerEvent.update({
          where: { id: ev.id },
          data: { status: dead ? "failed" : "pending", attempts, nextAttemptAt: new Date(Date.now() + backoffMs), lastError: String(err).slice(0, 200) },
        });
        failed++;
      }
    }
    const pending = await this.prisma.fiatLedgerEvent.count({ where: { status: "pending" } });
    return { sent, failed, pending };
  }
  /** Admin read-model for the callback outbox. */
  events(status?: string) {
    return this.prisma.fiatLedgerEvent.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: "desc" }, take: 100 });
  }
}
