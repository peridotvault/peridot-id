import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FiatTopupStatus, FiatWithdrawStatus, Prisma } from "@prisma/client";
import { buildInvoiceNumber, type PaymentProvider } from "@peridotvault/pid-payments";
import { PrismaService } from "../prisma/prisma.service";
import { PAYMENT_PROVIDER } from "./payment-provider.token";

const MIN_TOPUP_IDR = 10_000n;
const PAYMENT_DUE_MINUTES = 60;

export interface TopupView {
  id: string;
  invoiceNumber: string;
  amountIdr: string;
  currency: "IDR";
  provider: string;
  status: FiatTopupStatus;
  paymentUrl: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

export interface WithdrawView {
  id: string;
  amountIdr: string;
  currency: "IDR";
  status: string;
  createdAt: Date;
}

export interface FiatBalance {
  availableIdr: string;
  currency: "IDR";
}

/**
 * Fiat-only IDR ledger. Gateway-agnostic — every provider call goes through
 * the injected PaymentProvider, so switching gateways is env + provider class.
 */
@Injectable()
export class FiatService {
  private readonly logger = new Logger(FiatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** Fiat-only IDR top-up: one row + one hosted payment page from the provider. */
  async createTopup(pid: string, amountIdr: string): Promise<TopupView> {
    const amount = BigInt(amountIdr);
    if (amount < MIN_TOPUP_IDR) throw new ServiceUnavailableException("Minimum top-up is Rp10.000");
    const invoiceNumber = buildInvoiceNumber();
    const expiresAt = new Date(Date.now() + PAYMENT_DUE_MINUTES * 60_000);

    const row = await this.prisma.fiatTopup.create({
      data: { pid, invoiceNumber, amountIdr: amount, provider: this.provider.name, expiresAt },
    });

    let invoice;
    try {
      invoice = await this.provider.createInvoice({
        pid,
        amountIdr: amount,
        invoiceNumber,
        expiresAt,
        callbackUrl: this.config.get<string>("FIAT_CALLBACK_URL", ""),
      });
    } catch (err) {
      this.logger.error(`${this.provider.name} invoice failed: ${String(err)?.slice(0, 300)}`);
      throw new ServiceUnavailableException("Payment gateway failed — try again");
    }

    const updated = await this.prisma.fiatTopup.update({
      where: { id: row.id },
      data: { paymentUrl: invoice.paymentUrl, providerResponse: invoice.rawResponse ?? undefined },
    });
    return toTopupView(updated);
  }

  topups(pid: string): Promise<TopupView[]> {
    return this.prisma.fiatTopup
      .findMany({ where: { pid }, orderBy: { createdAt: "desc" }, take: 50 })
      .then((rows) => rows.map(toTopupView));
  }

  async topup(pid: string, id: string): Promise<TopupView | null> {
    const row = await this.prisma.fiatTopup.findFirst({ where: { id, pid } });
    return row ? toTopupView(row) : null;
  }

  /** Spendable IDR: Σ paid top-ups − Σ (pending + settled) withdraws. */
  async balance(pid: string): Promise<FiatBalance> {
    return { availableIdr: (await this.availableBalance(pid, this.prisma)).toString(), currency: "IDR" };
  }

  private availableBalance(pid: string, db: Prisma.TransactionClient): Promise<bigint> {
    return Promise.all([
      db.fiatTopup.aggregate({ _sum: { amountIdr: true }, where: { pid, status: "paid" } }),
      db.fiatWithdraw.aggregate({
        _sum: { amountIdr: true },
        where: { pid, status: { in: ["pending", "settled"] } },
      }),
    ]).then(([credits, debits]) => (credits._sum.amountIdr ?? 0n) - (debits._sum.amountIdr ?? 0n));
  }

  /**
   * IDR withdraw request, guarded by the available balance. The re-read +
   * insert run in one transaction so concurrent requests can't both pass.
   */
  async requestWithdraw(pid: string, amountIdr: string, destination?: Record<string, string>): Promise<WithdrawView> {
    const amount = BigInt(amountIdr);
    if (amount < MIN_TOPUP_IDR) throw new ServiceUnavailableException("Minimum withdraw is Rp10.000");
    return this.prisma.$transaction(async (tx) => {
      if (amount > (await this.availableBalance(pid, tx))) {
        throw new BadRequestException("Insufficient IDR balance");
      }
      const row = await tx.fiatWithdraw.create({
        data: { pid, amountIdr: amount, destination: destination ?? undefined },
      });
      return toWithdrawView(row);
    });
  }

  /** Admin settlement: pending → settled | rejected (idempotent on replay). */
  async settleWithdraw(id: string, decision: FiatWithdrawStatus): Promise<WithdrawView> {
    const row = await this.prisma.fiatWithdraw.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Withdraw request not found");
    if (row.status !== "pending") return toWithdrawView(row);
    const updated = await this.prisma.fiatWithdraw.update({ where: { id }, data: { status: decision } });
    return toWithdrawView(updated);
  }

  withdraws(pid: string): Promise<WithdrawView[]> {
    return this.prisma.fiatWithdraw
      .findMany({ where: { pid }, orderBy: { createdAt: "desc" }, take: 50 })
      .then((rows) => rows.map(toWithdrawView));
  }

  /**
   * Provider webhook (public route — authenticity comes from the gateway
   * signature over the raw body, not JWT). Idempotent: replays of a paid
   * invoice are no-ops.
   */
  async webhook(
    providerName: string,
    headers: Record<string, string | undefined>,
    rawBody: string,
    notifyPath: string,
  ): Promise<{ ok: boolean }> {
    if (providerName !== this.provider.name) return { ok: false };
    if (!this.provider.verifyWebhook(headers, rawBody, notifyPath)) {
      this.logger.warn(`${providerName} webhook signature mismatch`);
      return { ok: false };
    }
    const event = this.provider.parseWebhook(rawBody);
    if (!event) return { ok: false };

    const row = await this.prisma.fiatTopup.findUnique({ where: { invoiceNumber: event.invoiceNumber } });
    if (!row) return { ok: false };
    if (row.status === "paid") return { ok: true }; // idempotent replay

    await this.prisma.fiatTopup.update({
      where: { id: row.id },
      data: {
        status: event.status,
        paidAt: event.status === "paid" ? new Date() : undefined,
        providerResponse: event.rawResponse ?? undefined,
      },
    });
    return { ok: true };
  }
}

function toTopupView(r: {
  id: string;
  invoiceNumber: string;
  amountIdr: bigint;
  provider: string;
  status: FiatTopupStatus;
  paymentUrl: string | null;
  expiresAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}): TopupView {
  return {
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    amountIdr: r.amountIdr.toString(),
    currency: "IDR",
    provider: r.provider,
    status: r.status,
    paymentUrl: r.paymentUrl,
    expiresAt: r.expiresAt,
    paidAt: r.paidAt,
    createdAt: r.createdAt,
  };
}

function toWithdrawView(r: { id: string; amountIdr: bigint; status: string; createdAt: Date }): WithdrawView {
  return { id: r.id, amountIdr: r.amountIdr.toString(), currency: "IDR", status: r.status, createdAt: r.createdAt };
}
