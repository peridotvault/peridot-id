import { createHmac } from "node:crypto";
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import {
  buildInvoiceNumber,
  calcServiceFee,
  DEFAULT_FEE_POLICY,
  type DokuCheckoutClient,
} from "@peridotvault/pid-payments";
import { replayFiatLedger } from "./fiat-ledger-replay";
import { GENESIS_HASH, entryHash, verifyChain as verifyLedgerChain, type ChainableEntry } from "./fiat-ledger-hash";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { CHECKOUT_CLIENT } from "./checkout-client.token";

/** Minimum internal-credit issue, NET IDR. Mirrors the Checkout intent minimum
 *  (MIN_CHECKOUT_NET_IDR in fiat-subaccount.service) — kept as its own const
 *  so neither module imports the other at runtime (DI cycle). */
export const MIN_FIAT_DEPOSIT_NET_IDR = 100_000n;

/** Gateway payloads are JSON by contract — cast once, at the boundary. */
const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

interface FeeParams {
  version: number;
  percentBps: number;
  minIdr: bigint;
  maxIdr: bigint;
}

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
 * Phase-1 policy (`escrow-only`): every send must have an allowlisted app PID
 * on one side. user→user is rejected. Withdrawal/cash-out does not exist.
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
  async resolveAppContext(clientId?: string | null): Promise<{ id: string; ownerPid: string } | null> {
    if (!clientId) return null;
    const app = await this.prisma.pidApp
      .findUnique({ where: { clientId }, select: { id: true, ownerPid: true, isActive: true } })
      .catch(() => null);
    return app && app.isActive ? { id: app.id, ownerPid: app.ownerPid } : null;
  }

  /** App fee for an amount (0 when no app / not enabled). Clamp: min/max, 0 = unbounded. */
  private async appFeeFor(appId: string | null, operation: "topup" | "transaction" | "withdraw", amount: bigint): Promise<bigint> {
    if (!appId) return 0n;
    const f = await this.prisma.pidAppFee
      .findUnique({ where: { appId_operation: { appId, operation } } })
      .catch(() => null);
    if (!f || !f.enabled || f.percentBps <= 0) return 0n;
    return calcServiceFee(amount, { version: 0, percentBps: f.percentBps, minIdr: f.minIdr, maxIdr: f.maxIdr });
  }

  /**
   * Fee quote for an operation: the global PeridotID fee plus, when an app
   * context is given, that app's fee (credited to the app's own account).
   */
  async quoteFees(
    clientId: string | null | undefined,
    operation: "topup" | "transaction" | "withdraw",
    amount: bigint,
  ): Promise<{ globalFee: bigint; appFee: bigint; appId: string | null; appOwnerPid: string | null; policyVersion: number }> {
    const policy = await this.activeFeePolicy();
    const globalFee = calcServiceFee(amount, policy);
    const app = await this.resolveAppContext(clientId);
    const appFee = await this.appFeeFor(app?.id ?? null, operation, amount);
    return { globalFee, appFee, appId: app?.id ?? null, appOwnerPid: app?.ownerPid ?? null, policyVersion: policy.version };
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
    await this.security.log(row.pid, "fiat.issued", { parentRef: row.providerRef, net: net.toString(), fee: fee.toString() }).catch(() => undefined);
  }

  // --- send/receive (generic primitive + phase-1 policy gate) ---

  /**
   * Send inquiry (moves no money). GROSS-in: requested amount is gross;
   * fee quote + net computed under the active policy and pinned by
   * feePolicyVersion. Creates the intent row (`created`) the confirm step
   * posts atomically. Any PeridotID identity can be a recipient.
   */
  async transferInquiry(
    pid: string,
    input: { amountIdr: string; beneficiaryPid: string; remark?: string },
    appClientId?: string | null,
  ) {
    this.requireUsable();
    const gross = this.parseAmount(input.amountIdr);
    const beneficiaryPid = input.beneficiaryPid.trim().toLowerCase();
    if (beneficiaryPid === pid) throw new BadRequestException("Cannot transfer to yourself");
    const recipient = await this.prisma.identity.findUnique({ where: { pid: beneficiaryPid } }).catch(() => null);
    if (!recipient) throw new NotFoundException("Recipient has no PeridotID account yet");
    // Global PeridotID fee + (when an app initiated this) the app's own fee.
    const { globalFee, appFee, appId, appOwnerPid, policyVersion } = await this.quoteFees(appClientId, "transaction", gross);
    const totalFee = globalFee + appFee;
    const net = gross - totalFee;
    if (net <= 0n) throw new BadRequestException("Amount too small — net must be positive");
    const entryGroup = buildInvoiceNumber("CT");
    const row = await this.prisma.fiatLedgerEntry.create({
      data: {
        entryGroup, kind: "fiat_transfer_out", pid, counterpartyPid: beneficiaryPid,
        amountIdr: gross, direction: "out", idempotencyKey: entryGroup,
        status: "created", feePolicyVersion: policyVersion,
        counterparty: json({
          beneficiaryPid, feeQuote: globalFee.toString(), netQuote: net.toString(),
          feePolicyVersion: policyVersion,
          ...(appId && appOwnerPid ? { appId, appOwnerPid, appFeeQuote: appFee.toString() } : {}),
          ...(input.remark ? { remark: input.remark } : {}),
        }),
        source: "transfer-inquiry",
      },
    });
    await this.security.log(pid, "fiat.transfer_inquiry", { entryGroup, gross: gross.toString() }).catch(() => undefined);
    return {
      id: row.id, entryGroup, grossIdr: gross.toString(), feeIdr: totalFee.toString(),
      appFeeIdr: appFee.toString(), netIdr: net.toString(), feePolicyVersion: policyVersion, beneficiaryPid,
    };
  }

  /**
   * Confirm a send: posts sender-out + recipient-in + treasury-fee legs in ONE
   * DB transaction (DB row locks, PID-sorted). Idempotent: re-confirming a
   * posted intent returns the view. Balance is rechecked inside the txn —
   * no double-spend.
   */
  async transferConfirm(pid: string, id: string): Promise<FiatLedgerEntryView> {
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
    const appFee = this.quotedBigint(cp["appFeeQuote"]) ?? 0n;
    const appOwnerPid = typeof cp["appOwnerPid"] === "string" ? (cp["appOwnerPid"] as string) : null;
    const net = this.quotedBigint(cp["netQuote"]) ?? (gross - fee - appFee);
    const remark = typeof cp["remark"] === "string" ? (cp["remark"] as string) : undefined;
    const treasury = this.treasuryPid();

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockAccounts(tx as never, [pid, beneficiaryPid]);
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
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Unique race or concurrent confirm: re-read — posted wins.
      const reread = await this.prisma.fiatLedgerEntry.findFirst({ where: { id, pid } }).catch(() => null);
      if (reread?.status === "posted") return this.toTxView(reread as never);
      throw err instanceof Error ? err : new ServiceUnavailableException("Transfer failed — try again");
    }
    await this.security.log(pid, "fiat.transfer", { entryGroup: intent.entryGroup, gross: gross.toString() }).catch(() => undefined);
    // Third-party callbacks (escrow apps): notify on the committed movement.
    await this.enqueueTransferEvents({ entryGroup: intent.entryGroup, fromPid: pid, toPid: beneficiaryPid, grossIdr: gross, feeIdr: fee + appFee, netIdr: net });
    const done = await this.prisma.fiatLedgerEntry.findFirst({ where: { id, pid } });
    if (!done) throw new NotFoundException("Transfer not found");
    return this.toTxView(done as never);
  }

  /** Cancel a created (not yet posted) intent. Posted intents are immutable. */
  async cancelIntent(pid: string, id: string): Promise<FiatLedgerEntryView> {
    const row = await this.prisma.fiatLedgerEntry.findFirst({ where: { id, pid } });
    if (!row) throw new NotFoundException("Transfer not found");
    if (row.status !== "created") return this.toTxView(row as never);
    return this.toTxView((await this.prisma.fiatLedgerEntry.update({
      where: { id: row.id }, data: { status: "cancelled" },
    })) as never);
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
    return { mine, replayed };
  }

  /** Current internal-credit balance (replayed from posted rows). */
  async balance(pid: string) {
    const { replayed } = await this.replayForPid(pid);
    return {
      balanceIdr: (replayed.balances.get(pid) ?? 0n).toString(),
      currency: "IDR" as const,
      source: "fiat-ledger" as const,
      replayErrors: replayed.errors,
    };
  }

  /** Immutable journal export + replay verdict for one PID. */
  async journal(pid: string) {
    const { mine: rows, replayed } = await this.replayForPid(pid);
    return {
      pid,
      balanceIdr: (replayed.balances.get(pid) ?? 0n).toString(),
      treasuryCreditedIdr: replayed.treasury.toString(),
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
    let total = replayed.treasury;
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
      balances,
      inFlight: replayed.inFlight.length,
      errors: replayed.errors,
    };
  }

  // --- hash chain (tamper-evident journal) ---

  /** Global advisory lock id serializing chain writes (one ledger head). */
  private static readonly CHAIN_LOCK = 918273645;

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
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${FiatLedgerService.CHAIN_LOCK}::bigint)`);
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

  /** Verify the whole chain; expose the head hash for external anchoring. */
  async verifyLedger(): Promise<{ ok: boolean; checked: number; headHash: string; firstBadIdempotencyKey: string | null; error: string | null; postedUnchained: number }> {
    const unchained = await this.prisma.fiatLedgerEntry.count({ where: { status: "posted", hash: null } });
    const rows = await this.prisma.fiatLedgerEntry.findMany({
      where: { status: "posted", hash: { not: null } }, orderBy: { hashSeq: "asc" }, take: 100000,
    });
    const v = verifyLedgerChain(rows.map((r) => ({
      entryGroup: r.entryGroup, kind: r.kind, pid: r.pid, counterpartyPid: r.counterpartyPid,
      amountIdr: r.amountIdr, direction: r.direction, idempotencyKey: r.idempotencyKey,
      parentRef: r.parentRef, status: r.status, feePolicyVersion: r.feePolicyVersion,
      prevHash: r.prevHash, hash: r.hash,
    })));
    if (unchained > 0) {
      const e = v.error ? `${v.error}; ${unchained} posted row(s) unchained` : `${unchained} posted row(s) unchained — run chain backfill`;
      return { ...v, ok: false, error: e, postedUnchained: unchained };
    }
    return { ...v, postedUnchained: 0 };
  }

  /** Head of the chain (the value to publish externally to make it tamper-proof). */
  async chainHead(): Promise<{ headHash: string; hashSeq: string | null }> {
    const last = await this.prisma.fiatLedgerEntry.findFirst({
      where: { hash: { not: null } }, orderBy: { hashSeq: "desc" }, select: { hash: true, hashSeq: true },
    });
    return { headHash: last?.hash ?? GENESIS_HASH, hashSeq: last?.hashSeq?.toString() ?? null };
  }

  /** One-time/repair: chain posted rows that predate the chain (replaySeq order). */
  async backfillChain(): Promise<{ chained: number }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${FiatLedgerService.CHAIN_LOCK}::bigint)`);
      const unchained = await tx.fiatLedgerEntry.findMany({
        where: { status: "posted", hash: null }, orderBy: { replaySeq: "asc" }, take: 100000,
      });
      const last = await tx.fiatLedgerEntry.findFirst({
        where: { hash: { not: null } }, orderBy: { hashSeq: "desc" }, select: { hash: true, hashSeq: true },
      });
      let prevHash: string = last?.hash ?? GENESIS_HASH;
      let seq: bigint = last?.hashSeq ?? 0n;
      for (const r of unchained) {
        seq += 1n;
        const hash = entryHash({
          entryGroup: r.entryGroup, kind: r.kind, pid: r.pid, counterpartyPid: r.counterpartyPid,
          amountIdr: r.amountIdr, direction: r.direction, idempotencyKey: r.idempotencyKey,
          parentRef: r.parentRef, status: r.status, feePolicyVersion: r.feePolicyVersion, prevHash,
        });
        await tx.fiatLedgerEntry.update({ where: { id: r.id }, data: { prevHash, hash, hashSeq: seq } });
        prevHash = hash;
      }
      return { chained: unchained.length };
    });
  }

  // --- third-party callbacks (escrow apps) ---

  /**
   * Enqueue signed callbacks for a posted transfer to every party that owns an
   * active PidApp with a webhook URL (e.g. Live2Dev's escrow account). Written
   * after the ledger commits; delivered by dispatchEvents.
   */
  private async enqueueTransferEvents(e: { entryGroup: string; fromPid: string; toPid: string; grossIdr: bigint; feeIdr: bigint; netIdr: bigint }): Promise<void> {
    try {
      const apps = await this.prisma.pidApp.findMany({
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
      await Promise.all(apps.map((a) => this.prisma.fiatLedgerEvent.create({
        data: { eventType: "fiat.transfer.posted", targetPid: a.ownerPid, targetUrl: a.webhookUrl as string, payload: json(payload) },
      })));
    } catch (err) {
      this.logger.warn(`enqueue callbacks failed for ${e.entryGroup}: ${String(err)?.slice(0, 160)}`);
    }
  }

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
      const app = await this.prisma.pidApp.findFirst({ where: { ownerPid: ev.targetPid, isActive: true }, select: { webhookSecret: true } });
      const body = JSON.stringify(ev.payload);
      const sig = "sha256=" + createHmac("sha256", app?.webhookSecret ?? "").update(body).digest("hex");
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
    let bal = 0n;
    for (const r of rows) {
      if (r.direction === "in") bal += r.amountIdr;
      else if (r.direction === "out") bal -= r.amountIdr;
    }
    return bal;
  }

  private async activeFeePolicy(): Promise<FeeParams> {
    const policy = await this.prisma.fiatFeePolicy.findFirst({ where: { active: true }, orderBy: { version: "desc" } });
    if (policy) return { version: policy.version, percentBps: policy.percentBps, minIdr: policy.minIdr, maxIdr: policy.maxIdr };
    return { version: DEFAULT_FEE_POLICY.version, percentBps: DEFAULT_FEE_POLICY.percentBps, minIdr: DEFAULT_FEE_POLICY.minIdr, maxIdr: DEFAULT_FEE_POLICY.maxIdr };
  }

  private async feePolicyByVersion(version: number): Promise<FeeParams> {
    if (version > 0) {
      const row = await this.prisma.fiatFeePolicy.findUnique({ where: { version } }).catch(() => null);
      if (row) return { version: row.version, percentBps: row.percentBps, minIdr: row.minIdr, maxIdr: row.maxIdr };
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
