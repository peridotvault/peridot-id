import { postWebhook } from "./webhook-http";
import { createHmac } from "node:crypto";
import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { decryptSecret } from "../common/secret-crypto";

/** Transactional outbox; delivery is at-least-once, eventId is stable. */
@Injectable()
export class FiatLedgerEventsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(FiatLedgerEventsService.name);
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.dispatchEvents({}).catch(e => this.logger.error(String(e))).finally(() => { this.busy = false; });
    }, 2000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async dispatchEvents(input: { take?: number }): Promise<{ sent: number; failed: number; pending: number }> {
    const take = Math.min(Math.max(input.take ?? 20, 1), 100);
    const due = await this.prisma.fiatLedgerEvent.findMany({
      where: { status: "pending", nextAttemptAt: { lte: new Date() } }, orderBy: { nextAttemptAt: "asc" }, take,
    });
    let sent = 0, failed = 0;
    await Promise.all(due.map(async ev => {
      // Durable lease: multiple API replicas/admin dispatches cannot send the same
      // event concurrently. A crashed process leaves it retryable after one minute.
      const lease = new Date(Date.now() + 60_000);
      const claim = await this.prisma.fiatLedgerEvent.updateMany({
        where: { id: ev.id, status: "pending", nextAttemptAt: ev.nextAttemptAt }, data: { nextAttemptAt: lease },
      });
      if (!claim.count) return;
      const attempts = ev.attempts + 1;
      const payload = ev.payload as Record<string, unknown>;
      try {
        const app = await this.prisma.pidApp.findFirst({ where: { ownerPid: ev.targetPid,
          webhookUrl: ev.targetUrl, isActive: true,
          ...(typeof payload.appClientId === "string" ? { clientId: payload.appClientId } : {}),
        }, select: { webhookSecret: true } });
        const secret = decryptSecret(app?.webhookSecret ?? null, this.config.get<string>("PID_SECRETS_ENC_KEY", "") || undefined);
        if (!secret) throw new Error("Webhook app missing, inactive or secret unavailable");
        const body = JSON.stringify({ ...payload, eventId: ev.id, type: ev.eventType, occurredAt: payload.occurredAt ?? ev.createdAt.toISOString() });
        const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
        const res = await postWebhook(ev.targetUrl, {
          headers: { "Content-Type": "application/json", "X-Pid-Event": ev.eventType, "X-Pid-Signature": signature },
          body });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await this.prisma.fiatLedgerEvent.updateMany({ where: { id: ev.id, nextAttemptAt: lease },
          data: { status: "delivered", deliveredAt: new Date(), attempts, lastError: null } });
        sent++;
      } catch (err) {
        // 40 attempts, exponential delay capped at 1h: >24h retry window even
        // when every attempt fails immediately. Replay starts a new window.
        const backoffMs = Math.min(3_600_000, 1000 * 2 ** attempts);
        await this.prisma.fiatLedgerEvent.updateMany({ where: { id: ev.id, nextAttemptAt: lease },
          data: { status: attempts >= 40 ? "failed" : "pending", attempts,
            nextAttemptAt: new Date(Date.now() + backoffMs), lastError: String(err).slice(0, 200) } });
        failed++;
      }
    }));
    return { sent, failed, pending: await this.prisma.fiatLedgerEvent.count({ where: { status: "pending" } }) };
  }
  private async ownedApp(pid: string, id: string) {
    const app = await this.prisma.pidApp.findFirst({ where: { id, ownerPid: pid } });
    if (!app) throw new NotFoundException("App not found");
    return app;
  }
  async deliveries(pid: string, id: string) {
    const app = await this.ownedApp(pid, id);
    return this.prisma.fiatLedgerEvent.findMany({ where: { targetPid: pid,
      payload: { path: ["appClientId"], equals: app.clientId } }, orderBy: { createdAt: "desc" }, take: 100 });
  }
  async replay(pid: string, appId: string, eventId: string) {
    const app = await this.ownedApp(pid, appId);
    const updated = await this.prisma.fiatLedgerEvent.updateMany({ where: { id: eventId, targetPid: pid,
      payload: { path: ["appClientId"], equals: app.clientId } },
      data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), deliveredAt: null, lastError: null } });
    if (!updated.count) throw new NotFoundException("Delivery not found");
    return { eventId, status: "pending" };
  }
  events(status?: string) {
    return this.prisma.fiatLedgerEvent.findMany({ where: status ? { status } : undefined, orderBy: { createdAt: "desc" }, take: 100 });
  }
}
