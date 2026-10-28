import { createHmac, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import {
  buildInvoiceNumber,
  calcServiceFee,
  calcTaxAmount,
  DEFAULT_FEE_POLICY,
  type DokuCheckoutClient,
} from "@peridotvault/pid-payments";
import { decryptSecret } from "../common/secret-crypto";
import { replayFiatLedger } from "./fiat-ledger-replay";
import { CHAIN_LOCK, GENESIS_HASH, entryHash } from "./fiat-ledger-hash";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CHECKOUT_CLIENT } from "./checkout-client.token";

/** Minimum internal-credit issue, NET IDR. Mirrors the Checkout intent minimum
 *  (MIN_CHECKOUT_NET_IDR in fiat-subaccount.service) — kept as its own const
 *  so neither module imports the other at runtime (DI cycle). */
export const MIN_FIAT_DEPOSIT_NET_IDR = 50_000n;

/** Gateway payloads are JSON by contract — cast once, at the boundary. */
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

interface FeeParams {
  version: number;
  percentBps: number;
  minIdr: bigint;
  maxIdr: bigint;
  taxBps: number;
}

/**
 * App-fee operations. `escrow` is internal-only (campaign funding/refund legs):
 * it is deliberately NOT in the settable `FEE_OPERATIONS`, so it always
 * resolves to a 0 app fee. It exists so an escrow transfer can still carry the
 * app context (`clientId`) — a verified app then also skips the global fee,
 * giving an exact full refund and an exact streamer/platform split.
 */
export type FeeOperation = "topup" | "transaction" | "withdraw" | "escrow";

/** One immutable double-entry leg. The statement amount is `amountIdr` on the
 *  row's `direction` side — NOT a gross/fee/net quote (that belongs to the
 *  pre-confirmation transfer inquiry). */
export interface FiatLedgerEntryView {
  id: string;
  kind: string;
  entryGroup: string;
  counterpartyPid: string | null;
  amountIdr: string;
  direction: string;
  status: string;
  createdAt: Date;
}

/**
 * Fiat ledger — the spendable balance, statement and send/receive. Postgres is
 * the truth; DOKU Checkout is money-in only and DOKU settlement is backing.
 * See docs/FIAT_LEDGER.md.
 *
 * Generic infra only: account/identity, balance/credit, send/receive,
 * immutable journal. No campaign/developer/streamer/deal concepts here.
 *
 * Recipient policy (ANT-254: stated, not enforced): Phase-1 intends
 * escrow-only sends (an allowlisted app PID on one side, user→user
 * rejected), but transferInquiry/transferConfirm currently accept ANY active
 * PeridotID recipient — no allowlist check exists in this service. The
 * docstring on transferInquiry carries the same warning. Enforcing the
 * allowlist (PID_FIAT_LEDGER_APP_ALLOWLIST) is an open policy gap for the
 * product owner, not something this change silently introduces.
 */
@Injectable()
export class FiatLedgerService {
  private readonly logger = new Logger(FiatLedgerService.name);
  /** Ops override for the freeze switch (null = follow env). */
  private frozenOverride: boolean | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(CHECKOUT_CLIENT) private readonly checkout: DokuCheckoutClient,
    private readonly security: SecurityEventService,
  ) {}

  // --- flags (env-driven, never hardcoded) ---

  /** Master switch for issue + send. */
  ledgerEnabled(): boolean {
    return this.config.get<string>("PID_FIAT_LEDGER_ENABLED", "true") === "true";
  }

  /** Freeze switch for migration: new issues/sends rejected, reads stay. */
  ledgerFrozen(): boolean {
    if (this.frozenOverride !== null) return this.frozenOverride;
    return this.config.get<string>("PID_FIAT_LEDGER_FROZEN", "false") === "true";
  }

  setFrozenOverride(frozen: boolean | null) {
    this.frozenOverride = frozen;
  }


  /** Treasury label PID from env (accounting label only — fee legs reuse the
   *  sender-pid row pattern, credited to synthetic treasury in replay). */
  treasuryPid(): string | null {
    const raw = (this.config.get<string>("PID_FIAT_LEDGER_TREASURY_PID", "") || "").trim().toLowerCase();
    return raw || null;
  }

  private requireUsable(): void {
    if (!this.ledgerEnabled()) throw new ServiceUnavailableException("Internal credit is disabled");
    if (this.ledgerFrozen()) throw new ServiceUnavailableException("Internal credit is frozen for migration");
  }

  // --- fees (global PeridotID + stacked per-app) ---

  /** Resolve an active app by public clientId (fee context, model A). */
  async resolveAppContext(clientId?: string | null): Promise<{ id: string; ownerPid: string; isVerified: boolean } | null> {
    if (!clientId) return null;
    const app = await this.prisma.pidApp
      .findUnique({ where: { clientId }, select: { id: true, ownerPid: true, isActive: true, isVerified: true, verificationExpiresAt: true } })
      .catch(() => null);
    if (!app || !app.isActive) return null;
    // ANT-804 D3 edge 6: an expired grant behaves as unverified (waiver off).
    // Fee formula unchanged — verified still means globalFee=0 (D3 contract).
    const effective = app.isVerified && (!app.verificationExpiresAt || app.verificationExpiresAt.getTime() > Date.now());
    return { id: app.id, ownerPid: app.ownerPid, isVerified: effective };
  }

  /** App fee for an amount (0 when no app / not enabled). Clamp: min/max, 0 = unbounded. */
  private async appFeeFor(appId: string | null, operation: FeeOperation, amount: bigint): Promise<bigint> {
    if (!appId) return 0n;
    const f = await this.prisma.pidAppFee
      .findUnique({ where: { appId_operation: { appId, operation } } })
      .catch(() => null);
    if (!f || !f.enabled || f.percentBps <= 0) return 0n;
    return calcServiceFee(amount, { version: 0, percentBps: f.percentBps, minIdr: f.minIdr, maxIdr: f.maxIdr, taxBps: 0 });
  }

  /**
   * Fee quote for an operation: the global PeridotID fee plus, when an app
   * context is given, that app's fee (credited to the app's own account).
   * Verified partners skip the global fee only — their own stacked fee,
   * DOKU provider fees, and on-chain fees still apply.
   */
  async quoteFees(
    clientId: string | null | undefined,
    operation: FeeOperation,
    amount: bigint,
  ): Promise<{ globalFee: bigint; peridotTaxIdr: bigint; appFee: bigint; appId: string | null; appOwnerPid: string | null; policyVersion: number; isVerified: boolean }> {
    const policy = await this.activeFeePolicy();
    const app = await this.resolveAppContext(clientId);
    const globalFee = app?.isVerified ? 0n : calcServiceFee(amount, policy);
    const peridotTaxIdr = calcTaxAmount(globalFee, policy.taxBps);
    const appFee = await this.appFeeFor(app?.id ?? null, operation, amount);
    return { globalFee, peridotTaxIdr, appFee, appId: app?.id ?? null, appOwnerPid: app?.ownerPid ?? null, policyVersion: policy.version, isVerified: app?.isVerified ?? false };
  }

  // --- issue: Checkout SUCCESS → NET becomes internal credit ---

  /**
   * Issue internal credit for a PAID Checkout deposit (NET → user, FEE →
   * treasury). Never throws — safe from webhook/sync/reconcile/sweep paths.
   * Idempotent per deposit (`IC-<DP-providerRef>`).
   *
   * Gate (mirrors POINT issuance, minus DOKU movement): deposit row exists +
   * payment confirmed + checkout channel + amount not blocked + enabled +
   * unfrozen + re-corroborated order SUCCESS + exact amount-match.
   */
  async issueForDeposit(depositRowId: string, source: string): Promise<void> {
    try {
      await this.issueForDepositInner(depositRowId, source);
    } catch (err) {
      this.logger.warn(`issueFiatLedger failed: ${String(err)?.slice(0, 200)}`);
    }
  }

  private async issueForDepositInner(depositRowId: string, source: string): Promise<void> {
    const row = await this.prisma.fiatProviderTransaction.findUnique({ where: { id: depositRowId } }).catch(() => null);
    if (!row || row.kind !== "deposit") return;
    if (!this.isPaymentConfirmedRow(row as never)) return;
    if ((row.ledgerStatus ?? "") === "blocked") return; // amount mismatch — ops review
    const cp = (row.counterparty ?? {}) as Record<string, unknown>;
    if (cp["channel"] !== "checkout") return; // Checkout rail only — VA/inbound never issues
    if (!this.ledgerEnabled()) {
      this.logger.warn(`issue skipped for ${row.providerRef}: internal fiat ledger disabled`);
      return;
    }
    if (this.ledgerFrozen()) {
      this.logger.warn(`issue skipped for ${row.providerRef}: internal fiat ledger frozen`);
      return;
    }

    const issueKey = `IC-${row.providerRef}`;
    const existing = await this.prisma.fiatLedgerEntry.findUnique({ where: { idempotencyKey: issueKey } }).catch(() => null);
    if (existing && existing.status === "posted") return; // already done — no double issue

    // Re-corroborate against DOKU regardless of caller (never trust the push).
    let corr: { outcome: string; paidAmount: bigint | null };
    try {
      const st = await this.checkout.checkOrderStatus(row.providerRef);
      corr = { outcome: st.paid ? "paid" : "pending", paidAmount: st.paidAmount ?? null };
    } catch (err) {
      this.logger.warn(`issue corroboration failed for ${row.providerRef}: ${String(err)?.slice(0, 200)}`);
      return;
    }
    if (corr.outcome !== "paid") return;
    if (corr.paidAmount === null || corr.paidAmount !== row.amountIdr) {
      await this.prisma.fiatProviderTransaction.update({
        where: { id: row.id },
        data: {
          ledgerStatus: "blocked",
          counterparty: json({ ...((row.counterparty ?? {}) as Record<string, unknown>), amountMismatch: corr.paidAmount?.toString() ?? "unparseable" }),
        },
      }).catch(() => undefined);
      this.logger.error(`FIAT-LEDGER ISSUE BLOCKED amount mismatch for ${row.providerRef}`);
      return;
    }

    const net = this.quotedBigint(cp["netQuote"]) ?? row.netIdr ?? null;
    const fee = this.quotedBigint(cp["feeQuote"]) ?? row.feeIdr ?? 0n;
    const tax = this.quotedBigint(cp["taxQuote"]) ?? 0n;
    const appFee = this.quotedBigint(cp["appFeeQuote"]) ?? 0n;
    const appOwnerPid = typeof cp["appOwnerPid"] === "string" ? (cp["appOwnerPid"] as string) : null;
    if (net === null || net < MIN_FIAT_DEPOSIT_NET_IDR) {
      this.logger.warn(`issue skipped for ${row.providerRef}: net below minimum or unknown`);
      return;
    }
    const policyVersion = typeof cp["feePolicyVersion"] === "number" ? (cp["feePolicyVersion"] as number) : (row.feePolicyVersion ?? null);
    const group = issueKey;
    const treasury = this.treasuryPid();

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.appendChained(tx as never, [
          {
            data: {
              entryGroup: group, kind: "fiat_issue", pid: row.pid, amountIdr: net,
              direction: "in", idempotencyKey: issueKey, parentRef: row.providerRef,
              feePolicyVersion: policyVersion,
              counterparty: json({ parentRef: row.providerRef, netQuote: net.toString(), feeQuote: fee.toString(), treasury }),
              source,
            },
          },
          ...(fee > 0n
            ? [{
                data: {
                  entryGroup: group, kind: "fiat_fee", pid: row.pid, amountIdr: fee,
                  direction: "out", idempotencyKey: `${issueKey}-FEE`, parentRef: row.providerRef,
                  feePolicyVersion: policyVersion,
                  counterparty: json({ parentRef: row.providerRef, destination: "treasury", treasury }),
                  source,
                },
              }]
            : []),
          // PeridotID PPN (VAT) on the global fee → the tax bucket (a liability).
          ...(tax > 0n
            ? [{
                data: {
                  entryGroup: group, kind: "fiat_tax", pid: row.pid, amountIdr: tax,
                  direction: "out", idempotencyKey: `${issueKey}-TAX`, parentRef: row.providerRef,
                  feePolicyVersion: policyVersion,
                  counterparty: json({ parentRef: row.providerRef, destination: "tax" }),
                  source,
                },
              }]
            : []),
          // Per-app topup fee → the app's own account (stacks on the global fee).
          ...(appFee > 0n && appOwnerPid
            ? [{
                data: {
                  entryGroup: group, kind: "fiat_app_fee", pid: appOwnerPid, amountIdr: appFee,
                  direction: "in", idempotencyKey: `${issueKey}-APPFEE`, parentRef: row.providerRef,
                  feePolicyVersion: policyVersion,
                  counterparty: json({ parentRef: row.providerRef, destination: "app", payerPid: row.pid }),
                  source,
                },
              }]
            : []),
        ]);
      });
    } catch (err) {
      // Unique violation = concurrent issue won the race — verify posted, else rethrow to log.
      const done = await this.prisma.fiatLedgerEntry.findUnique({ where: { idempotencyKey: issueKey } }).catch(() => null);
      if (done?.status === "posted") return;
      throw err;
    }
    await this.security.log(row.pid, "fiat.issued", { parentRef: row.providerRef, net: net.toString(), fee: fee.toString() }).catch((err) => {
      this.logger.error(`AUDIT-SINK-FAILURE fiat.issued ${row.providerRef} unaudited: ${String(err)?.slice(0, 200)}`);
    });
  }

  // --- send/receive (generic primitive + phase-1 policy gate) ---

  /**
   * Sandbox faucet caps (ANT-287 §6, proposed values — CTO confirms via
   * parent OQ-1; adjust here and in the openapi spec together).
   */
  static readonly FAUCET_PER_CALL_MAX_IDR = 50_000n;
  static readonly FAUCET_DAILY_CAP_IDR = 100_000n;
  static readonly FAUCET_DAILY_MAX_CALLS = 10;

  /**
   * Faucet gate flag (ANT-290 contract): true IFF `PID_FAUCET_ENABLED` is
   * exactly `"true"`. Fail-closed — unset/"false"/anything-else ⇒ off.
   * Never DOKU_MODE (defaults to sandbox ⇒ would fail open).
   */
  faucetEnabled(): boolean {
    return this.config.get<string>("PID_FAUCET_ENABLED", "false") === "true";
  }

  /** Boundary check for faucet amounts: null/missing/zero/negative/over-max → 422 (never 400). */
  private parseFaucetAmount(raw: unknown): bigint {
    let v: bigint | null = null;
    if (typeof raw === "number" && Number.isInteger(raw)) {
      try {
        v = BigInt(raw);
      } catch {
        v = null;
      }
    } else if (typeof raw === "string" && /^\d+$/.test(raw)) {
      try {
        v = BigInt(raw);
      } catch {
        v = null;
      }
    }
    if (v === null || v <= 0n || v > FiatLedgerService.FAUCET_PER_CALL_MAX_IDR) {
      throw new UnprocessableEntityException({
        error: "faucet_invalid_amount",
        perCallMaxMinor: FiatLedgerService.FAUCET_PER_CALL_MAX_IDR.toString(),
      });
    }
    return v;
  }

  /**
   * Mint sandbox test credit straight into the ledger (ANT-287 FR-2).
   *
   * Same `fiat_issue` leg shape as corroborated Checkout deposits, so
   * balance/webhook behavior is identical — but no deposit row and no DOKU
   * corroboration, so the faucet works when DOKU sandbox is down.
   *
   * Concurrency: the per-identity day-bucket count + sum and the insert run
   * inside one transaction behind `lockAccounts` (per-pid `FOR UPDATE` on
   * `identities`), so concurrent double-calls are serialized and can never
   * jointly exceed the daily cap or call budget. Every mint is audited via
   * `security.log` (`fiat.faucet_minted`).
   */
  async mintTestCredit(
    pid: string,
    amountMinor: unknown,
  ): Promise<{ creditId: string; amountMinor: string; currency: "IDR"; env: "sandbox"; dailyRemainingMinor: string }> {
    this.requireUsable();
    if (!this.faucetEnabled()) throw new NotFoundException("Not found");
    const amount = this.parseFaucetAmount(amountMinor);
    const creditId = randomUUID();
    const issueKey = `FAUCET-${creditId}`;
    let remaining = 0n;
    await this.prisma.$transaction(async (tx) => {
      await this.lockAccounts(tx as never, [pid]);
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const todays = (await (tx as unknown as {
        fiatLedgerEntry: {
          findMany: (a: unknown) => Promise<Array<{ amountIdr: bigint }>>;
        };
      }).fiatLedgerEntry.findMany({
        where: { pid, kind: "fiat_issue", source: "faucet", status: "posted", createdAt: { gte: dayStart } },
        select: { amountIdr: true },
      })) as Array<{ amountIdr: bigint }>;
      let spent = 0n;
      for (const r of todays) spent += r.amountIdr;
      if (
        todays.length >= FiatLedgerService.FAUCET_DAILY_MAX_CALLS ||
        spent + amount > FiatLedgerService.FAUCET_DAILY_CAP_IDR
      ) {
        const left = FiatLedgerService.FAUCET_DAILY_CAP_IDR - spent;
        throw new UnprocessableEntityException({
          error: "faucet_cap_exceeded",
          dailyRemainingMinor: (left > 0n ? left : 0n).toString(),
        });
      }
      remaining = FiatLedgerService.FAUCET_DAILY_CAP_IDR - spent - amount;
      await this.appendChained(tx as never, [
        {
          data: {
            entryGroup: creditId,
            kind: "fiat_issue",
            pid,
            amountIdr: amount,
            direction: "in",
            idempotencyKey: issueKey,
            parentRef: null,
            feePolicyVersion: null,
            counterparty: json({ faucet: true, creditId }),
            source: "faucet",
          },
        },
      ]);
    });
    await this.security
      .log(pid, "fiat.faucet_minted", { creditId, amountMinor: amount.toString() })
      .catch((err) => {
        this.logger.error(`AUDIT-SINK-FAILURE fiat.faucet_minted ${creditId} unaudited: ${String(err)?.slice(0, 200)}`);
      });
    return {
      creditId,
      amountMinor: amount.toString(),
      currency: "IDR",
      env: "sandbox",
      dailyRemainingMinor: remaining.toString(),
    };
  }

  /**
   * Send inquiry (moves no money). GROSS-in: requested amount is gross;
   * fee quote + net computed under the active policy and pinned by
   * feePolicyVersion. Creates the intent row (`created`) the confirm step
   * posts atomically. Any active PeridotID identity can be a recipient —
   * NO allowlist is enforced here (see the class doc: Phase-1 escrow-only
   * is a stated policy with no check; user→user sends succeed today).
   */
  /**
   * ANT-344 H3 defense in depth: money paths reject machine tokens without
   * the explicit `fiat:transfer` scope even if a route guard is bypassed or
   * miswired. User sessions (no `app` claim) are unaffected.
   */
  private requireTransferScope(auth?: { app?: string; scope?: string }): void {
    if (auth?.app && auth.scope !== "fiat:transfer") {
      throw new ForbiddenException("Machine token scope not authorized for transfers");
    }
  }

  async transferInquiry(
    pid: string,
    input: { amountIdr: string; beneficiaryPid: string; remark?: string; operation?: FeeOperation },
    appClientId?: string | null,
    auth?: { app?: string; scope?: string },
  ) {
    this.requireTransferScope(auth);
    this.requireUsable();
    const gross = this.parseAmount(input.amountIdr);
    const beneficiaryPid = input.beneficiaryPid.trim().toLowerCase();
    if (beneficiaryPid === pid) throw new BadRequestException("Cannot transfer to yourself");
    const recipient = await this.prisma.identity.findUnique({ where: { pid: beneficiaryPid } }).catch(() => null);
    if (!recipient) throw new NotFoundException("Recipient has no PeridotID account yet");
    // Global PeridotID fee (+ its PPN) + (when an app initiated this) the app's own
    // fee for the operation (default "transaction"; "escrow" legs carry no app fee).
    const { globalFee, peridotTaxIdr, appFee, appId, appOwnerPid, policyVersion } = await this.quoteFees(appClientId, input.operation ?? "transaction", gross);
    const totalFee = globalFee + peridotTaxIdr + appFee;
    const net = gross - totalFee;
    if (net <= 0n) throw new BadRequestException("Amount too small — net must be positive");
    const entryGroup = buildInvoiceNumber("CT");
    const row = await this.prisma.fiatLedgerEntry.create({
      data: {
        entryGroup, kind: "fiat_transfer_out", pid, counterpartyPid: beneficiaryPid,
        amountIdr: gross, direction: "out", idempotencyKey: entryGroup,
        status: "created", feePolicyVersion: policyVersion,
        counterparty: json({
          beneficiaryPid, feeQuote: globalFee.toString(), taxQuote: peridotTaxIdr.toString(), netQuote: net.toString(),
          feePolicyVersion: policyVersion,
          ...(appId && appOwnerPid ? { appId, appOwnerPid, appFeeQuote: appFee.toString() } : {}),
          ...(input.remark ? { remark: input.remark } : {}),
        }),
        source: "transfer-inquiry",
      },
    });
    await this.security.log(pid, "fiat.transfer_inquiry", { entryGroup, gross: gross.toString() }).catch((err) => {
      this.logger.error(`AUDIT-SINK-FAILURE fiat.transfer_inquiry ${entryGroup} unaudited: ${String(err)?.slice(0, 200)}`);
    });
    // ANT-286b SOC signal: machine-token use on money paths (leaked pidsk_ detection).
    if (auth?.app) {
      await this.security.log(pid, "fiat.transfer.app_token", { app: auth.app, scope: auth.scope ?? null, entryGroup, phase: "inquiry" }).catch((err) => {
        this.logger.error(`AUDIT-SINK-FAILURE fiat.transfer.app_token ${entryGroup} unaudited: ${String(err)?.slice(0, 200)}`);
      });
    }
    return {
      id: row.id, entryGroup, grossIdr: gross.toString(), feeIdr: totalFee.toString(),
      peridotFeeIdr: globalFee.toString(), peridotTaxIdr: peridotTaxIdr.toString(),
      appFeeIdr: appFee.toString(), netIdr: net.toString(), feePolicyVersion: policyVersion, beneficiaryPid,
    };
  }

  /**
   * Confirm a send: posts sender-out + recipient-in + treasury-fee legs in ONE
   * DB transaction (DB row locks, PID-sorted). Idempotent: re-confirming a
   * posted intent returns the view. Balance is rechecked inside the txn —
   * no double-spend.
   */
  async transferConfirm(pid: string, id: string, auth?: { app?: string; scope?: string }): Promise<FiatLedgerEntryView> {
    this.requireTransferScope(auth);
    this.requireUsable();
    const intent = await this.prisma.fiatLedgerEntry.findFirst({ where: { id, pid } });
    if (!intent) throw new NotFoundException("Transfer not found");
    if (intent.kind !== "fiat_transfer_out") throw new BadRequestException("Not a transfer intent");
    if (intent.status === "posted") return this.toTxView(intent as never);
    if (intent.status !== "created") throw new BadRequestException("Transfer is closed — start a new inquiry");
    const beneficiaryPid = intent.counterpartyPid;
    if (!beneficiaryPid) throw new ServiceUnavailableException("Inquiry handshake incomplete — start a new inquiry");
    const cp = (intent.counterparty ?? {}) as Record<string, unknown>;
    const policy = await this.feePolicyByVersion(intent.feePolicyVersion ?? 0);
    const gross = intent.amountIdr;
    // Honor the inquiry snapshot (user approved it); fall back to recompute.
    const fee = this.quotedBigint(cp["feeQuote"]) ?? calcServiceFee(gross, policy);
    const tax = this.quotedBigint(cp["taxQuote"]) ?? calcTaxAmount(fee, policy.taxBps);
    const appFee = this.quotedBigint(cp["appFeeQuote"]) ?? 0n;
    const appOwnerPid = typeof cp["appOwnerPid"] === "string" ? (cp["appOwnerPid"] as string) : null;
    const net = this.quotedBigint(cp["netQuote"]) ?? (gross - fee - tax - appFee);
    const remark = typeof cp["remark"] === "string" ? (cp["remark"] as string) : undefined;
    const treasury = this.treasuryPid();

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockAccounts(tx as never, [pid, beneficiaryPid]);
        // Close the cancel-vs-confirm race: cancelIntent takes the same
        // identity lock, so this status read is serialized against cancel.
        // A cancelled (or otherwise closed) intent must never post legs.
        // ANT-344 L1: re-read stays pid-scoped — a row id alone must never
        // resolve another identity's intent inside the txn.
        const fresh = await tx.fiatLedgerEntry.findFirst({ where: { id: intent.id, pid } });
        if (!fresh || fresh.status !== "created") {
          throw new BadRequestException("Transfer is closed — start a new inquiry");
        }
        const senderBalance = await this.postedBalanceTx(tx as never, pid);
        if (senderBalance < gross) {
          throw new BadRequestException("Insufficient internal credit");
        }
        await this.appendChained(tx as never, [
          // Sender leg = the inquiry row, now posted (its fields are already set).
          {
            id: intent.id,
            data: {
              entryGroup: intent.entryGroup, kind: "fiat_transfer_out", pid,
              counterpartyPid: beneficiaryPid, amountIdr: gross, direction: "out",
              idempotencyKey: intent.idempotencyKey, parentRef: intent.entryGroup,
              feePolicyVersion: policy.version,
            },
          },
          {
            data: {
              entryGroup: intent.entryGroup, kind: "fiat_transfer_in", pid: beneficiaryPid,
              counterpartyPid: pid, amountIdr: net, direction: "in",
              idempotencyKey: `${intent.entryGroup}-IN`, parentRef: intent.entryGroup,
              feePolicyVersion: policy.version,
              counterparty: json({ parentRef: intent.entryGroup, senderPid: pid, ...(remark ? { remark } : {}) }),
              source: "transfer-confirm",
            },
          },
          ...(fee > 0n
            ? [{
                data: {
                  entryGroup: intent.entryGroup, kind: "fiat_fee", pid,
                  amountIdr: fee, direction: "out",
                  idempotencyKey: `${intent.entryGroup}-FEE`, parentRef: intent.entryGroup,
                  feePolicyVersion: policy.version,
                  counterparty: json({ parentRef: intent.entryGroup, destination: "treasury", treasury }),
                  source: "transfer-confirm",
                },
              }]
            : []),
          // PeridotID PPN (VAT) on the global fee → the tax bucket.
          ...(tax > 0n
            ? [{
                data: {
                  entryGroup: intent.entryGroup, kind: "fiat_tax", pid,
                  amountIdr: tax, direction: "out",
                  idempotencyKey: `${intent.entryGroup}-TAX`, parentRef: intent.entryGroup,
                  feePolicyVersion: policy.version,
                  counterparty: json({ parentRef: intent.entryGroup, destination: "tax" }),
                  source: "transfer-confirm",
                },
              }]
            : []),
          // Per-app fee → the app's own account (stacks on the global fee).
          ...(appFee > 0n && appOwnerPid
            ? [{
                data: {
                  entryGroup: intent.entryGroup, kind: "fiat_app_fee", pid: appOwnerPid,
                  amountIdr: appFee, direction: "in",
                  idempotencyKey: `${intent.entryGroup}-APPFEE`, parentRef: intent.entryGroup,
                  feePolicyVersion: policy.version,
                  counterparty: json({ parentRef: intent.entryGroup, destination: "app", payerPid: pid }),
                  source: "transfer-confirm",
                },
              }]
            : []),
        ]);
        // Atomic outbox (ANT-254): the callback rows commit in the SAME
        // transaction as the legs. A retried confirm can never fork a second
        // callback (`idempotencyKey` = entryGroup:targetPid); dispatchEvents
        // remains the async relay with HMAC + retries.
        await this.enqueueTransferEventsTx(tx as never, {
          entryGroup: intent.entryGroup, fromPid: pid, toPid: beneficiaryPid,
          grossIdr: gross, feeIdr: fee + tax + appFee, netIdr: net,
        });
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Unique race or concurrent confirm: re-read — posted wins.
      const reread = await this.prisma.fiatLedgerEntry.findFirst({ where: { id, pid } }).catch(() => null);
      if (reread?.status === "posted") return this.toTxView(reread as never);
      throw err instanceof Error ? err : new ServiceUnavailableException("Transfer failed — try again");
    }
    await this.security.log(pid, "fiat.transfer", { entryGroup: intent.entryGroup, gross: gross.toString() }).catch((err) => {
      this.logger.error(`AUDIT-SINK-FAILURE fiat.transfer ${intent.entryGroup} unaudited: ${String(err)?.slice(0, 200)}`);
    });
    // ANT-286b SOC signal: machine-token use on money paths (leaked pidsk_ detection).
    if (auth?.app) {
      await this.security.log(pid, "fiat.transfer.app_token", { app: auth.app, scope: auth.scope ?? null, entryGroup: intent.entryGroup, phase: "confirm" }).catch((err) => {
        this.logger.error(`AUDIT-SINK-FAILURE fiat.transfer.app_token ${intent.entryGroup} unaudited: ${String(err)?.slice(0, 200)}`);
      });
    }
    const done = await this.prisma.fiatLedgerEntry.findFirst({ where: { id, pid } });
    if (!done) throw new NotFoundException("Transfer not found");
    return this.toTxView(done as never);
  }

  /** Cancel a created (not yet posted) intent. Posted intents are immutable.
   * Takes the same identity lock as transferConfirm so cancel-vs-confirm is
   * serialized: whoever holds the lock first wins, the loser sees final status. */
  async cancelIntent(pid: string, id: string): Promise<FiatLedgerEntryView> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccounts(tx as never, [pid]);
      const row = await tx.fiatLedgerEntry.findFirst({ where: { id, pid } });
      if (!row) throw new NotFoundException("Transfer not found");
      if (row.status !== "created") return this.toTxView(row as never);
      // Guarded claim: a concurrent confirm that already posted (status flip
      // between the read above and here) makes count === 0 and we return the
      // posted row instead of overwriting it back to cancelled.
      await tx.fiatLedgerEntry.updateMany({
        where: { id: row.id, status: "created" },
        data: { status: "cancelled" },
      });
      // ANT-344 L1: re-read stays pid-scoped (same rationale as confirm).
      const final = await tx.fiatLedgerEntry.findFirst({ where: { id: row.id, pid } });
      if (!final) throw new NotFoundException("Transfer not found");
      return this.toTxView(final as never);
    });
  }

  // --- corrections (reversal/adjustment writer) ---

  /**
   * Admin correction: post a balanced fiat_adjust pair (debit fromPid, credit
   * toPid, same amount, one entryGroup) atomically through the chained
   * writer — the kind replay already folds (ANT-254 gap: no writer existed).
   * Both legs are chained, idempotency-keyed (`<entryGroup>-OUT/-IN`), and
   * the sender balance is rechecked inside the identity-locked txn.
   *
   * Idempotent on `requestId` (ANT-264: Tobias Finding 2): when supplied,
   * the leg keys are deterministic (`ADJ-<requestId>-OUT/-IN`) and a retried
   * call returns the original entryGroup. Same key with different
   * fromPid/toPid/amount → 409 Conflict. Without a key each POST mints a
   * fresh pair (caller must de-dupe; admin-only + 10/min throttle bound it).
   *
   * Boundary: TRANSFER corrections live here. ISSUANCE clawbacks stay on the
   * propose→approve clawback path (FiatSubAccountService) — issuance legs
   * (`fiat_issue`/`fiat_fee`) credit the sender/treasury with no counterparty
   * identity to mirror against, so a pair-adjust cannot express them.
   */
  async adminAdjust(
    adminPid: string,
    input: { fromPid: string; toPid: string; amountIdr: string; reason: string; requestId?: string },
  ): Promise<{ entryGroup: string }> {
    this.requireUsable();
    const fromPid = input.fromPid.trim().toLowerCase();
    const toPid = input.toPid.trim().toLowerCase();
    if (!fromPid || !toPid) throw new BadRequestException("fromPid and toPid are required");
    if (fromPid === toPid) throw new BadRequestException("fromPid and toPid must differ");
    const reason = (input.reason ?? "").trim();
    if (reason.length < 8) throw new BadRequestException("reason is required (min 8 chars) — adjustments are audited");
    const amount = this.parseAmount(input.amountIdr);
    const requestId = (input.requestId ?? "").trim() || null;
    if (requestId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
      throw new BadRequestException("requestId must be 1-64 chars of [A-Za-z0-9_-]");
    }
    for (const pid of [fromPid, toPid]) {
      const ident = await this.prisma.identity.findUnique({ where: { pid } }).catch(() => null);
      // ANT-344 L9: never echo the queried identifier in a client-visible
      // error — the admin caller already knows the input they sent.
      if (!ident) throw new NotFoundException("Identity not found");
    }
    // Deterministic keys when the caller supplies requestId; random per-POST
    // otherwise (legacy behavior, documented above).
    const outKey = requestId !== null ? `ADJ-${requestId}-OUT` : null;
    const inKey = requestId !== null ? `ADJ-${requestId}-IN` : null;
    const entryGroup = requestId !== null ? `ADJ-${requestId}` : buildInvoiceNumber("ADJ");
    if (outKey !== null) {
      const prior = await this.prisma.fiatLedgerEntry.findUnique({ where: { idempotencyKey: outKey } }).catch(() => null);
      if (prior && prior.status === "posted") {
        this.assertAdjustMatches(prior as never, { fromPid, toPid, amount });
        return { entryGroup: (prior as { entryGroup: string }).entryGroup };
      }
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockAccounts(tx as never, [fromPid, toPid]);
        const senderBalance = await this.postedBalanceTx(tx as never, fromPid);
        if (senderBalance < amount) {
          throw new BadRequestException("Insufficient internal credit");
        }
        await this.appendChained(tx as never, [
          {
            data: {
              entryGroup, kind: "fiat_adjust", pid: fromPid, counterpartyPid: toPid,
              amountIdr: amount, direction: "out", idempotencyKey: outKey ?? `${entryGroup}-OUT`,
              parentRef: entryGroup,
              counterparty: json({ parentRef: entryGroup, adjustFrom: fromPid, adjustTo: toPid, reason, ...(requestId !== null ? { requestId } : {}) }),
              source: "admin-adjust",
            },
          },
          {
            data: {
              entryGroup, kind: "fiat_adjust", pid: toPid, counterpartyPid: fromPid,
              amountIdr: amount, direction: "in", idempotencyKey: inKey ?? `${entryGroup}-IN`,
              parentRef: entryGroup,
              counterparty: json({ parentRef: entryGroup, adjustFrom: fromPid, adjustTo: toPid, reason, ...(requestId !== null ? { requestId } : {}) }),
              source: "admin-adjust",
            },
          },
        ]);
      });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof NotFoundException || err instanceof ConflictException) throw err;
      // Unique race on a keyed retry: the concurrent POST won — verify the
      // posted row and return its group instead of a second pair.
      if (outKey !== null && this.isUniqueViolation(err)) {
        const won = await this.prisma.fiatLedgerEntry.findUnique({ where: { idempotencyKey: outKey } }).catch(() => null);
        if (won && (won as { status: string }).status === "posted") {
          this.assertAdjustMatches(won as never, { fromPid, toPid, amount });
          return { entryGroup: (won as { entryGroup: string }).entryGroup };
        }
      }
      throw err instanceof Error ? err : new ServiceUnavailableException("Adjustment failed — try again");
    }
    // Fail-open WITH alert (ANT-264: Tobias Finding 3): the money has moved
    // at this point, so a throw would lie about the ledger state — but a
    // silent swallow would leave money unaudited. The ERROR log is the alert
    // signal for ops log monitoring (same convention as the BLOCKED line in
    // issueForDepositInner). Never `.catch(() => undefined)` here.
    await this.security.log(adminPid, "fiat.adjust", {
      entryGroup, fromPid, toPid, amount: amount.toString(), reason: reason.slice(0, 160),
    }).catch((err) => {
      this.logger.error(`AUDIT-SINK-FAILURE fiat.adjust ${entryGroup} unaudited: ${String(err)?.slice(0, 200)}`);
    });
    return { entryGroup };
  }

  /** Idempotent-retry guard: same requestId must mean the same movement. */
  private assertAdjustMatches(
    row: { pid: string; counterpartyPid: string | null; amountIdr: bigint; direction: string | null },
    want: { fromPid: string; toPid: string; amount: bigint },
  ): void {
    if (row.pid !== want.fromPid || row.counterpartyPid !== want.toPid || row.amountIdr !== want.amount || row.direction !== "out") {
      throw new ConflictException("requestId already used for a different adjustment — use a fresh key");
    }
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
  }

  // --- reads (replay is the balance) ---

  /**
   * Replay covering the PID's full movements: a send's legs live under
   * different pids, so the verdict folds every row in the PID's entryGroups
   * (group-balance checks are only meaningful on complete groups — a
   * pid-sliced replay would false-positive on every send).
   */
  private async replayForPid(pid: string) {
    const mine = await this.prisma.fiatLedgerEntry.findMany({
      where: { pid }, take: 5000, orderBy: { replaySeq: "asc" },
    });
    const groups = [...new Set(mine.map((r) => r.entryGroup))];
    const legs = groups.length === 0 ? [] : await this.prisma.fiatLedgerEntry.findMany({
      where: { entryGroup: { in: groups } }, take: 10000, orderBy: { replaySeq: "asc" },
    });
    // Bounded reads must never silently compute a wrong balance: flag
    // truncation so callers (and the UI) know the verdict is partial.
    const truncated = mine.length >= 5000 || legs.length >= 10000;
    const replayed = replayFiatLedger(legs.map((r) => ({
      kind: r.kind, pid: r.pid, idempotencyKey: r.idempotencyKey, entryGroup: r.entryGroup,
      amountIdr: r.amountIdr, direction: r.direction, status: r.status, replaySeq: r.replaySeq,
    })));
    // Counterparty balances are partial by construction here (only groups
    // touching this pid are loaded), so their negativity is not a verdict —
    // keep group/structural errors and this pid's own negativity only.
    replayed.errors = replayed.errors.filter(
      (e) => !e.startsWith("owner ") || e.startsWith(`owner ${pid} `),
    );
    return { mine, replayed, truncated };
  }

  /** Current internal-credit balance (replayed from posted rows). */
  async balance(pid: string) {
    const { replayed, truncated } = await this.replayForPid(pid);
    return {
      balanceIdr: (replayed.balances.get(pid) ?? 0n).toString(),
      currency: "IDR" as const,
      source: "fiat-ledger" as const,
      replayErrors: replayed.errors,
      truncated,
    };
  }

  /**
   * Immutable journal export + replay verdict for one PID. NOTE (ANT-254):
   * treasury/tax here are PARTIAL — folded from this PID's entryGroups only,
   * not platform totals (a group slices by participation, so most fee/tax
   * legs belonging to other groups are absent). The global source of truth
   * is adminReplay; the scope flags below say so on the wire so no consumer
   * mistakes these for platform totals.
   */
  async journal(pid: string) {
    const { mine: rows, replayed, truncated } = await this.replayForPid(pid);
    return {
      pid,
      balanceIdr: (replayed.balances.get(pid) ?? 0n).toString(),
      truncated,
      treasuryCreditedIdr: replayed.treasury.toString(),
      taxCreditedIdr: replayed.tax.toString(),
      treasuryScope: "partial: this pid's groups only — platform totals at admin/replay",
      inFlight: replayed.inFlight,
      errors: replayed.errors,
      rows: rows.map((r) => ({
        id: r.id, kind: r.kind, entryGroup: r.entryGroup, counterpartyPid: r.counterpartyPid,
        amountIdr: r.amountIdr.toString(), direction: r.direction,
        idempotencyKey: r.idempotencyKey, parentRef: r.parentRef, status: r.status,
        feePolicyVersion: r.feePolicyVersion, source: r.source, createdAt: r.createdAt,
      })),
    };
  }

  /** Platform-wide replay projection (bounded) + rail switches. */
  async adminReplay() {
    const rows = await this.prisma.fiatLedgerEntry.findMany({
      take: 5000, orderBy: { replaySeq: "asc" },
    });
    const replayed = replayFiatLedger(rows.map((r) => ({
      kind: r.kind, pid: r.pid, idempotencyKey: r.idempotencyKey, entryGroup: r.entryGroup,
      amountIdr: r.amountIdr, direction: r.direction, status: r.status, replaySeq: r.replaySeq,
    })));
    let total = replayed.treasury + replayed.tax;
    const balances: Record<string, string> = {};
    for (const [owner, bal] of replayed.balances) {
      balances[owner] = bal.toString();
      total += bal;
    }
    return {
      enabled: this.ledgerEnabled(),
      frozen: this.ledgerFrozen(),
      treasuryPid: this.treasuryPid(),
      rows: rows.length,
      truncated: rows.length >= 5000,
      outstandingIdr: total.toString(),
      treasuryIdr: replayed.treasury.toString(),
      taxIdr: replayed.tax.toString(),
      balances,
      inFlight: replayed.inFlight.length,
      errors: replayed.errors,
    };
  }

  // --- hash chain (tamper-evident journal) ---

  /** Global advisory lock id serializing chain writes (one ledger head). */

  /**
   * Append value-bearing legs to the tamper-evident chain and write them.
   * Serialized by an advisory lock; each row commits to the prior head. Every
   * posted row MUST go through here (never a bare create) so the chain is
   * complete. `ops[].id` updates an existing row (the transfer intent) instead
   * of inserting.
   */
  private async appendChained(
    tx: {
      $executeRaw: (q: unknown) => Promise<number>;
      fiatLedgerEntry: {
        findFirst: (a: unknown) => Promise<{ hash: string | null; hashSeq: bigint | null } | null>;
        create: (a: unknown) => Promise<unknown>;
        update: (a: unknown) => Promise<unknown>;
      };
    },
    ops: Array<{ id?: string; data: Record<string, unknown> }>,
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${CHAIN_LOCK}::bigint)`);
    const last = await tx.fiatLedgerEntry.findFirst({
      where: { hash: { not: null } }, orderBy: { hashSeq: "desc" }, select: { hash: true, hashSeq: true },
    });
    let prevHash: string = last?.hash ?? GENESIS_HASH;
    let seq: bigint = last?.hashSeq ?? 0n;
    for (const op of ops) {
      seq += 1n;
      const d = op.data;
      const hash = entryHash({
        entryGroup: String(d.entryGroup), kind: String(d.kind), pid: String(d.pid),
        counterpartyPid: (d.counterpartyPid as string | null) ?? null,
        amountIdr: d.amountIdr as bigint, direction: String(d.direction),
        idempotencyKey: String(d.idempotencyKey), parentRef: (d.parentRef as string | null) ?? null,
        status: "posted", feePolicyVersion: (d.feePolicyVersion as number | null) ?? null,
        prevHash,
      });
      const data = { ...d, status: "posted", prevHash, hash, hashSeq: seq };
      if (op.id) await tx.fiatLedgerEntry.update({ where: { id: op.id }, data });
      else await tx.fiatLedgerEntry.create({ data });
      prevHash = hash;
    }
  }

  // --- third-party callbacks (escrow apps) ---

  /**
   * Enqueue signed callbacks for a posted transfer to every party that owns an
   * active PidApp with a webhook URL (e.g. Live2Dev's escrow account). MUST be
   * called inside the ledger write transaction (atomic outbox) — never
   * post-commit. A callback row without its legs (or legs without callbacks)
   * is unrepresentable: both commit or neither does.
   */
  private async enqueueTransferEventsTx(
    tx: {
      pidApp: {
        findMany: (a: unknown) => Promise<Array<{ ownerPid: string; webhookUrl: string | null }>>;
      };
      fiatLedgerEvent: {
        findFirst: (a: unknown) => Promise<{ id: string } | null>;
        create: (a: unknown) => Promise<unknown>;
      };
    },
    e: { entryGroup: string; fromPid: string; toPid: string; grossIdr: bigint; feeIdr: bigint; netIdr: bigint },
  ): Promise<void> {
    const apps = await tx.pidApp.findMany({
      where: { ownerPid: { in: [e.fromPid, e.toPid] }, isActive: true, webhookUrl: { not: null } },
      select: { ownerPid: true, webhookUrl: true },
    });
    if (apps.length === 0) return;
    const payload = {
      event: "fiat.transfer.posted", entryGroup: e.entryGroup,
      from: e.fromPid, to: e.toPid,
      grossIdr: e.grossIdr.toString(), feeIdr: e.feeIdr.toString(), netIdr: e.netIdr.toString(),
      at: new Date().toISOString(),
    };
    for (const a of apps) {
      if (!a.webhookUrl) continue;
      // Retried confirms converge: the first commit wins, later ones skip.
      const idempotencyKey = `${e.entryGroup}:${a.ownerPid}`;
      const existing = await tx.fiatLedgerEvent.findFirst({ where: { idempotencyKey } });
      if (existing) continue;
      await tx.fiatLedgerEvent.create({
        data: {
          eventType: "fiat.transfer.posted", targetPid: a.ownerPid, targetUrl: a.webhookUrl,
          payload: json(payload), idempotencyKey,
        },
      });
    }
  }

  /** Payment-confirmation predicate for deposit rows (same semantics as the
   *  POINT gate: prefers providerPaymentStatus, legacy fallback). */
  private isPaymentConfirmedRow(row: { providerPaymentStatus?: string | null; providerStatus: string }): boolean {
    const payment = row.providerPaymentStatus ?? null;
    if (payment != null) return payment === "success";
    return row.providerStatus === "success" || row.providerStatus === "settled";
  }

  private quotedBigint(v: unknown): bigint | null {
    if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }

  private parseAmount(raw: string): bigint {
    if (!/^\d+$/.test(raw)) throw new BadRequestException("Amount must be whole IDR (positive integer)");
    const v = BigInt(raw);
    if (v <= 0n) throw new BadRequestException("Amount must be positive");
    return v;
  }

  /** DB-level lock: the arbiter across instances (PID-sorted, deadlock-free).
   *  Locks the `identities` rows directly — every credit holder IS an identity
   *  (enforced by the journal FK), so no marker table is needed. The in-txn
   *  balance recheck stays the double-spend guard. */
  private async lockAccounts(tx: { $queryRaw: (q: unknown) => Promise<unknown> }, pids: string[]) {
    const keys = [...new Set(pids)].sort();
    await tx.$queryRaw(
      Prisma.sql`SELECT "pid" FROM "identities" WHERE "pid" IN (${Prisma.join(keys)}) ORDER BY "pid" FOR UPDATE`,
    );
  }

  private async postedBalanceTx(tx: { fiatLedgerEntry: { findMany: (a: never) => Promise<Array<{ kind: string; amountIdr: bigint; direction: string | null }>> } }, pid: string): Promise<bigint> {
    const rows = await tx.fiatLedgerEntry.findMany({
      where: { pid, status: "posted" },
      select: { kind: true, amountIdr: true, direction: true },
    } as never) as Array<{ kind: string; amountIdr: bigint; direction: string | null }>;
    return this.sumPosted(rows);
  }

  private sumPosted(rows: Array<{ kind: string; amountIdr: bigint; direction: string | null }>): bigint {
    // Kind-aware to match replayFiatLedger exactly: fiat_fee / fiat_tax rows
    // credit the treasury / tax buckets and never debit the owner, so the
    // in-txn guard must not subtract them either (else the guard balance
    // drifts below the displayed replay balance by cumulative fees+tax).
    let bal = 0n;
    for (const r of rows) {
      switch (r.kind) {
        case "fiat_issue":
        case "fiat_transfer_in":
        case "fiat_app_fee":
          if (r.direction === "in") bal += r.amountIdr;
          break;
        case "fiat_transfer_out":
          if (r.direction === "out") bal -= r.amountIdr;
          break;
        case "fiat_adjust":
          if (r.direction === "in") bal += r.amountIdr;
          else if (r.direction === "out") bal -= r.amountIdr;
          break;
        // fiat_fee / fiat_tax (and unknown kinds): no owner-side effect.
        default:
          break;
      }
    }
    return bal;
  }

  private async activeFeePolicy(): Promise<FeeParams> {
    const policy = await this.prisma.fiatFeePolicy.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
    if (policy) return { version: policy.version, percentBps: policy.percentBps, minIdr: policy.minIdr, maxIdr: policy.maxIdr, taxBps: policy.taxBps };
    return { version: DEFAULT_FEE_POLICY.version, percentBps: DEFAULT_FEE_POLICY.percentBps, minIdr: DEFAULT_FEE_POLICY.minIdr, maxIdr: DEFAULT_FEE_POLICY.maxIdr, taxBps: DEFAULT_FEE_POLICY.taxBps };
  }

  private async feePolicyByVersion(version: number): Promise<FeeParams> {
    if (version > 0) {
      const row = await this.prisma.fiatFeePolicy.findUnique({ where: { version } }).catch(() => null);
      if (row) return { version: row.version, percentBps: row.percentBps, minIdr: row.minIdr, maxIdr: row.maxIdr, taxBps: row.taxBps };
    }
    return this.activeFeePolicy();
  }

  private toTxView(r: {
    id: string; kind: string; entryGroup: string; counterpartyPid: string | null;
    amountIdr: bigint; direction: string | null; status: string; createdAt: Date;
  }): FiatLedgerEntryView {
    return {
      id: r.id,
      kind: r.kind,
      entryGroup: r.entryGroup,
      counterpartyPid: r.counterpartyPid,
      amountIdr: r.amountIdr.toString(),
      direction: r.direction ?? (r.kind === "fiat_transfer_in" || r.kind === "fiat_issue" ? "in" : "out"),
      status: r.status,
      createdAt: r.createdAt,
    };
  }
}
