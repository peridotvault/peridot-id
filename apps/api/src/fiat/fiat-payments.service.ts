import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type FiatPayment } from "@prisma/client";
import { codesForCategory, type DokuCheckoutClient, isPaymentMethodCategory, parseCheckoutNotify } from "@peridotvault/pid-payments";
import { AuthenticatedUser } from "../common/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";
import { CHECKOUT_CLIENT } from "./checkout-client.token";
import { FiatLedgerService } from "./fiat-ledger.service";
import { FiatSubAccountService } from "./fiat-subaccount.service";
import { CreatePaymentDto, ListPaymentsDto, PaymentQuoteDto, RefundPaymentDto } from "./dto/payment.dto";
import { MAX_PAYMENT_IDR } from "./fiat-limits";

@Injectable()
export class FiatPaymentsService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly logger = new Logger(FiatPaymentsService.name);
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService,
    private readonly ledger: FiatLedgerService, private readonly fiat: FiatSubAccountService,
    @Inject(CHECKOUT_CLIENT) private readonly checkout: DokuCheckoutClient) {}

  onModuleInit() {
    this.timer = setInterval(() => { void this.reconcile().catch(e => this.fail(e)); }, 3000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  /** A schema that is behind (migration not applied) must not log every tick. */
  private fail(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2021" || e.code === "P2022")) {
      if (this.timer) clearInterval(this.timer);
      this.logger.error(`Fiat payment scheduler stopped: ${e.code} — run prisma migrate deploy, then restart the API`);
      return;
    }
    this.logger.error(String(e));
  }
  private usable() {
    if (!this.ledger.ledgerEnabled() || this.ledger.ledgerFrozen()) throw new ServiceUnavailableException("Fiat ledger unavailable");
  }
  private async app(user: AuthenticatedUser, clientId?: string) {
    if (user.app && user.scope !== "fiat:payment" && user.scope !== "read") throw new ForbiddenException("Machine token requires fiat:payment scope");
    if (user.app && clientId && clientId !== user.app) throw new ForbiddenException("App context mismatch");
    const id = user.app ?? clientId;
    if (!id) throw new BadRequestException("clientId is required for session payments");
    const app = await this.prisma.pidApp.findUnique({ where: { clientId: id } });
    if (!app?.isActive || (user.app && app.ownerPid !== user.pid)) throw new ForbiddenException("App unavailable");
    return app;
  }
  async quote(user: AuthenticatedUser, input: PaymentQuoteDto) {
    if (BigInt(input.amountIdr) > MAX_PAYMENT_IDR) {
      throw new BadRequestException({ code: "PAYMENT_ABOVE_CEILING", maximumIdr: MAX_PAYMENT_IDR.toString(), message: "Amount above maximum" });
    }
    const app = await this.app(user, input.clientId);
    const q = await this.fiat.quoteDeposit(input.amountIdr, app.clientId, input.paymentMethod);
    return { ...q, grossIdr: q.amountIdr, feeIdr: (BigInt(q.totalIdr) - BigInt(q.amountIdr)).toString() };
  }
  private view(p: FiatPayment) {
    return { id: p.id, appClientId: p.appClientId, payerPid: p.payerPid, beneficiaryPid: p.beneficiaryPid,
      status: p.status, paymentUrl: ["created", "pending"].includes(p.status) && p.expiresAt > new Date() ? p.paymentUrl : null,
      grossIdr: p.amountIdr.toString(), netIdr: p.amountIdr.toString(), feeIdr: p.feeIdr.toString(), totalIdr: p.totalIdr.toString(),
      externalId: p.externalId, description: p.description, metadata: p.metadata, expiresAt: p.expiresAt, paidAt: p.paidAt,
      createdAt: p.createdAt, refundedIdr: p.refundedIdr.toString() };
  }
  private async owned(user: AuthenticatedUser, id: string) {
    const p = await this.prisma.fiatPayment.findUnique({ where: { id } });
    if (!p || (user.app ? p.appClientId !== user.app : p.payerPid !== user.pid)) throw new NotFoundException("Payment not found");
    if (user.app) await this.app(user);
    return p;
  }
  async create(user: AuthenticatedUser, input: CreatePaymentDto): Promise<ReturnType<FiatPaymentsService["view"]>> {
    this.usable();
    const app = await this.app(user, input.clientId);
    if (user.scope === "read") throw new ForbiddenException("Read-only token");
    // Method decides the DOKU gateway fee in totalIdr; without it the platform
    // absorbs the provider fee on every payment.
    if (!input.paymentMethod) throw new BadRequestException("paymentMethod is required");
    const payerPid = user.app ? input.payerPid ?? null : user.pid;
    if (!user.app && input.payerPid && input.payerPid !== user.pid) throw new ForbiddenException("Payer mismatch");
    const prior = await this.prisma.fiatPayment.findUnique({ where: { appClientId_externalId: { appClientId: app.clientId, externalId: input.externalId } } });
    if (prior) {
      if (prior.payerPid !== payerPid || prior.amountIdr !== BigInt(input.amountIdr) || prior.beneficiaryPid !== (input.beneficiaryPid ?? app.ownerPid)) throw new ConflictException("externalId already used with different payment details");
      return this.view(prior);
    }
    const beneficiaryPid = input.beneficiaryPid ?? app.ownerPid;
    if (Buffer.byteLength(JSON.stringify(input.metadata ?? {}), "utf8") > 2048) throw new BadRequestException("metadata exceeds 2KB");
    for (const pid of [beneficiaryPid, payerPid].filter((p): p is string => !!p)) {
      if (!await this.prisma.identity.findUnique({ where: { pid } })) throw new BadRequestException("Identity unavailable");
    }
    const q = await this.quote(user, input);
    const id = `fpay_${randomUUID()}`;
    let row: FiatPayment;
    try {
      row = await this.prisma.fiatPayment.create({ data: {
        id, appClientId: app.clientId, payerPid, beneficiaryPid, externalId: input.externalId,
        description: input.description, metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        amountIdr: BigInt(input.amountIdr), feeIdr: BigInt(q.feeIdr), totalIdr: BigInt(q.totalIdr),
        quote: q as unknown as Prisma.InputJsonValue, providerRef: `FP${randomUUID().replace(/-/g, "").slice(0, 28)}`,
        expiresAt: new Date(Date.now() + 30 * 60_000),
      } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return this.create(user, input);
      throw e;
    }
    // Only the creator of the unique row calls DOKU. Ambiguous failures never
    // create another invoice on retry; reconciliation recovers the same reference.
    try {
      const method = input.paymentMethod?.toUpperCase();
      const payment = await this.checkout.createPayment({ invoiceNumber: row.providerRef, grossAmountIdr: row.totalIdr,
        customer: payerPid ? { id: payerPid, name: payerPid } : {}, dueMinutes: 30, recoverAbandonedCart: false,
        ...(method && isPaymentMethodCategory(method) ? { paymentMethodTypes: codesForCategory(method) } : {}),
        notifyUrl: this.config.get<string>("DOKU_CHECKOUT_NOTIFY_URL", "") || this.config.get<string>("DOKU_WEBHOOK_URL", "") || undefined,
      });
      const expiresAt = payment.expiredDate && /^\d{14}$/.test(payment.expiredDate)
        ? new Date(payment.expiredDate.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6+07:00")) : row.expiresAt;
      await this.prisma.fiatPayment.updateMany({ where: { id, status: "created" }, data: { status: "pending", paymentUrl: payment.paymentUrl, expiresAt } });
    } catch (e) { this.logger.warn(`Checkout creation unresolved for ${id}: ${String(e).slice(0, 160)}`); }
    return this.view((await this.prisma.fiatPayment.findUniqueOrThrow({ where: { id } })));
  }
  async get(user: AuthenticatedUser, id: string) { return this.view(await this.owned(user, id)); }
  async list(user: AuthenticatedUser, input: ListPaymentsDto) {
    const app = await this.app(user, input.clientId);
    return (await this.prisma.fiatPayment.findMany({ where: { appClientId: app.clientId,
      ...(!user.app ? { payerPid: user.pid } : {}), externalId: input.externalId, status: input.status,
      ...(input.createdAfter ? { createdAt: { gt: new Date(input.createdAfter) } } : {}),
    }, orderBy: { createdAt: "desc" }, take: 100 })).map(p => this.view(p));
  }
  async cancel(user: AuthenticatedUser, id: string) {
    const p = await this.owned(user, id);
    await this.sync(p);
    const changed = await this.prisma.fiatPayment.updateMany({ where: { id, status: { in: ["created", "pending"] } }, data: { status: "cancelled" } });
    if (!changed.count) throw new ConflictException("Payment cannot be cancelled");
    return this.get(user, id);
  }
  async notify(rawBody: string) {
    let body: unknown;
    try { body = JSON.parse(rawBody); } catch { return; }
    const notification = parseCheckoutNotify(body);
    if (!notification) return;
    const p = await this.prisma.fiatPayment.findUnique({ where: { providerRef: notification.invoiceNumber } });
    if (p) await this.sync(p);
  }
  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.prisma.fiatPayment.findMany({ where: { status: { in: ["created", "pending", "cancelled"] }, nextCheckAt: { lte: new Date() }, createdAt: { gt: new Date(Date.now() - 86_400_000) } }, orderBy: { nextCheckAt: "asc" }, take: 100 });
      await Promise.allSettled(rows.map(async p => {
        // Young intents are polled every ~5s so a PAID confirmation turns into a
        // ledger posting + webhook in well under 10s; older ones back off.
        const young = p.createdAt > new Date(Date.now() - 3 * 60_000);
        const claim = await this.prisma.fiatPayment.updateMany({ where: { id: p.id, nextCheckAt: p.nextCheckAt }, data: { nextCheckAt: new Date(Date.now() + (young ? 5_000 : 30_000)) } });
        if (claim.count) await this.sync(p);
      }));
    } finally { this.busy = false; }
  }
  private async event(tx: Prisma.TransactionClient, p: FiatPayment, type: string) {
    const app = await tx.pidApp.findUnique({ where: { clientId: p.appClientId } });
    if (!app?.isActive || !app.webhookUrl) return;
    const eventId = randomUUID();
    await tx.fiatLedgerEvent.create({ data: { id: eventId, eventType: type, idempotencyKey: `${p.id}:${type}`,
      targetPid: app.ownerPid, targetUrl: app.webhookUrl, payload: { eventId, type, occurredAt: new Date().toISOString(),
        appClientId: p.appClientId, externalId: p.externalId, paymentId: p.id, amountIdr: p.amountIdr.toString(),
        feeIdr: p.feeIdr.toString(), payerPid: p.payerPid } } });
  }
  async sync(p: FiatPayment) {
    if (p.status === "paid") return;
    const st = await this.checkout.checkOrderStatus(p.providerRef);
    // A mismatch can never resolve itself: close it so it stops being polled
    // and the app is told, instead of dangling until the 24h sweep drops it.
    if (st.paid && st.paidAmount !== p.totalIdr) {
      this.logger.error(`Payment amount mismatch ${p.id}: paid ${st.paidAmount} vs invoiced ${p.totalIdr}`);
      await this.prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${p.id}, 0))`;
        const current = await tx.fiatPayment.findUniqueOrThrow({ where: { id: p.id } });
        if (["paid", "failed", "expired", "cancelled"].includes(current.status)) return;
        await tx.fiatPayment.update({ where: { id: p.id }, data: { status: "failed" } });
        await this.event(tx, current, "fiat.payment.failed");
      });
      return;
    }
    const status = st.paid ? "paid" : (st.expired || p.expiresAt <= new Date()) ? "expired" : st.txStatus === "FAILED" ? "failed" : null;
    if (!status) return;
    this.usable();
    await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${p.id}, 0))`;
      const current = await tx.fiatPayment.findUniqueOrThrow({ where: { id: p.id } });
      if (current.status === "paid" || current.status === status || (["failed", "expired", "cancelled"].includes(current.status) && status !== "paid")) return;
      // A late confirmed payment is accounted for even after local cancellation.
      if (status === "paid") {
        const q = p.quote as Record<string, string>;
        const legs = [{ data: { entryGroup: p.id, kind: "fiat_payment_in", pid: p.beneficiaryPid,
          counterpartyPid: p.payerPid, amountIdr: p.amountIdr, direction: "in", idempotencyKey: `${p.id}:IN`, parentRef: p.id, source: "payment" } }];
        const tax = BigInt(q.peridotTaxIdr ?? "0");
        const fee = BigInt(q.peridotFeeIdr ?? "0");
        const appFee = BigInt(q.appFeeIdr ?? "0");
        const app = await tx.pidApp.findUniqueOrThrow({ where: { clientId: p.appClientId } });
        for (const [kind, amount, pid, direction] of [["fiat_fee", fee, p.beneficiaryPid, "out"], ["fiat_tax", tax, p.beneficiaryPid, "out"], ["fiat_app_fee", appFee, app.ownerPid, "in"]] as const) {
          if (amount > 0n) legs.push({ data: { entryGroup: p.id, kind, pid, counterpartyPid: p.payerPid,
            amountIdr: amount, direction, idempotencyKey: `${p.id}:${kind}`, parentRef: p.id, source: "payment" } });
        }
        await this.ledger.appendChained(tx as never, legs);
      }
      await tx.fiatPayment.update({ where: { id: p.id }, data: { status, ...(status === "paid" ? { paidAt: new Date() } : {}) } });
      await this.event(tx, p, `fiat.payment.${status}`);
    });
  }
  async refund(user: AuthenticatedUser, id: string, input: RefundPaymentDto) {
    this.usable();
    const p = await this.prisma.fiatPayment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException("Payment not found");
    const app = await this.app(user, user.app ?? p.appClientId);
    if (p.appClientId !== app.clientId || user.pid !== p.beneficiaryPid || (user.app && user.scope !== "fiat:payment")) throw new ForbiddenException("Only beneficiary can refund this payment");
    if (!p.payerPid) throw new ConflictException("Payment has no payer PID; cannot refund to a machine identity");
    const key = `${id}:refund:${input.requestId}`;
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
      const current = await tx.fiatPayment.findUniqueOrThrow({ where: { id } });
      const existing = await tx.fiatLedgerEntry.findUnique({ where: { idempotencyKey: `${key}:OUT` } });
      if (existing) {
        if (input.amountIdr && existing.amountIdr !== BigInt(input.amountIdr)) throw new ConflictException("Refund requestId conflict");
        return { refundId: key, amountIdr: existing.amountIdr.toString() };
      }
      const amount = input.amountIdr ? BigInt(input.amountIdr) : current.amountIdr - current.refundedIdr;
      if (current.status !== "paid" || amount <= 0n || amount > current.amountIdr - current.refundedIdr) throw new ConflictException("Refund exceeds remaining paid amount");
      await this.ledger.lockAccounts(tx as never, [p.beneficiaryPid, p.payerPid!]);
      if (await this.ledger.postedBalanceTx(tx as never, p.beneficiaryPid) < amount) throw new BadRequestException("Insufficient beneficiary balance");
      await this.ledger.appendChained(tx as never, [
        { data: { entryGroup: key, kind: "fiat_adjust", pid: p.beneficiaryPid, counterpartyPid: p.payerPid, amountIdr: amount, direction: "out", idempotencyKey: `${key}:OUT`, parentRef: id, source: "payment-refund" } },
        { data: { entryGroup: key, kind: "fiat_adjust", pid: p.payerPid, counterpartyPid: p.beneficiaryPid, amountIdr: amount, direction: "in", idempotencyKey: `${key}:IN`, parentRef: id, source: "payment-refund" } },
      ]);
      await tx.fiatPayment.update({ where: { id }, data: { refundedIdr: { increment: amount } } });
      return { refundId: key, amountIdr: amount.toString() };
    });
  }
}
