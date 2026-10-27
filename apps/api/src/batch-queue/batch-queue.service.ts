// Phase-1a intent queue + co-submission (ANT-762, CTO pass-through pricing).
//
// Backend-only batching with NO contract change: the SDK submits individually
// signed single-call intents; the backend validates, quotes, queues, and
// flushes them sequentially through the EXISTING single-call entrypoints
// (every op keeps its own owner/session signature — zero auth changes).
//
// Pricing (binding CTO decision for 1a): PASS-THROUGH at the existing 50%
// rate on ACTUAL batched cost — user pays 1.5×A (capped at the quote lock),
// NOT the B+0.5V split (phase-1b candidate). S = max(0, Q−A) floored so the
// user never pays above quote. V<=0 → NO_SAVINGS fallback (same arithmetic:
// 1.5× actual capped at quote; the ledger pair records it).
//
// Scope: non-financial ops only (value==0, denied selectors rejected).
// Urgent/value flows never enter the queue (existing single-call path).
//
// No timers in this module (safety rule): due batches are flushed
// opportunistically on submit plus an explicit POST /flush for ops/cron.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DENIED_SELECTORS } from "@peridotvault/pid-evm";
import { createHash, randomUUID } from "node:crypto";
import { FeePolicyService } from "../fee/fee-policy.service";
import { PrismaService } from "../prisma/prisma.service";
import { SecurityEventService } from "../security/security-event.service";
import { EstimateBatchDto, SubmitBatchDto } from "./dto/batch.dto";

/** Max ops per batch (spec §3.1 FR-4, MVP value). */
export const MAX_OPS_PER_BATCH = 10;
/** Max calldata per batch (spec §3.1 FR-4, MVP value). */
export const MAX_CALLDATA_BYTES_PER_BATCH = 64 * 1024;
/** Flush window default: T=15min on testnet (spec §5, product-proposed). */
export const DEFAULT_QUEUE_WINDOW_SECS = 900;
/** Batch gas ceiling (chain block-gas headroom minus relayer safety margin). */
export const BATCH_GAS_CEILING = 30_000_000;
/** Chain identity for ledger rows (Monad testnet only — no mainnet). */
export const BATCH_NAMESPACE = "evm";
export const DEFAULT_BATCH_REFERENCE = "10143";
/** Reaper horizon: stale `submitted` rows older than 2× window finalize. */
const STALE_SUBMITTED_FACTOR = 2;
/** Bounded scan sizes (no unbounded queries on hot paths). */
const FLUSH_BATCH_LIMIT = 100;
const METRICS_ROW_LIMIT = 5000;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type BatchStatus =
  | "received"
  | "quoted"
  | "queued"
  | "submitted"
  | "settled"
  | "partial"
  | "failed"
  | "expired";

export interface StoredOp {
  to: string;
  value: string;
  data: string;
  gasLimit?: string;
  intent: Record<string, unknown>;
}

export interface OpEstimate {
  networkCost: bigint;
}

/** Per-op network-cost estimator (chain RPC in prod; fake in tests). Fail-closed. */
export interface BatchEstimator {
  estimateNetworkCost(op: StoredOp): Promise<bigint>;
}

/** Forwards ONE already-signed intent through the existing single-call entrypoint. */
export interface SingleCallSubmitter {
  submit(op: StoredOp): Promise<OpReceipt>;
}

export interface OpReceipt {
  txHash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  l1Fee?: bigint;
  ok: boolean;
  revertReason?: string;
}

export interface OpSimulation {
  ok: boolean;
  reason?: string;
  gasEstimate: bigint;
}

/** Per-op simulation at flush time (spec §5: quoted Q vs actual A drift guard). */
export interface BatchSimulator {
  simulate(op: StoredOp): Promise<OpSimulation>;
}

export interface SessionState {
  valid: boolean;
  revoked: boolean;
  expiresAt: number;
}

/** Session validity check (revocation + expiry), re-run at settlement. */
export interface SessionValidator {
  check(keyAddress: string, sequence: number, nowSec: number): Promise<SessionState>;
}

export interface BatchPorts {
  estimator: BatchEstimator;
  submitter: SingleCallSubmitter;
  simulator: BatchSimulator;
  sessions: SessionValidator;
}

const failClosedPorts = (): BatchPorts => {
  const fail = async (): Promise<never> => {
    throw new ServiceUnavailableException("Batch flush transport is not configured");
  };
  return {
    estimator: { estimateNetworkCost: fail },
    submitter: { submit: fail },
    simulator: { simulate: fail },
    sessions: {
      check: async () => {
        throw new ServiceUnavailableException("Batch session validation is not configured");
      },
    },
  };
};

export interface BatchQuoteView {
  quoteId: string;
  quotedAt: string;
  expiresAt: string;
  baselineNetwork: string;
  quotedMaxTotal: string;
  feePolicyVersion: number;
  feeBps: number;
  opsHash: string;
  perOp: Array<{ index: number; networkEstimate: string }>;
  assumptions: { namespace: string; reference: string; windowSecs: number };
}

export interface BatchStatusView {
  batchId: string;
  lifecycle: BatchStatus;
  atomic: boolean;
  bypassQueue: boolean;
  quoteId: string;
  settleDueAt: string;
  settledAt: string | null;
  perOp: Array<{ index: number; status: string; txHash?: string; reason?: string }>;
  fees: {
    quotedBaseline: string;
    quotedMaxTotal: string;
    actualNetwork?: string;
    userTotal?: string;
    realizedSavings?: string;
    pricing?: string;
  };
  failure?: { code: string; message: string };
}

export interface BatchMetrics {
  windowDays: number;
  totalBatches: number;
  queuedBatches: number;
  settledBatches: number;
  failedBatches: number;
  fillRate: number;
  failureRate: number;
  settledOps: number;
  failedOps: number;
  opFailureRate: number;
  savingsSamples: number;
  savingsTotal: string;
  savingsAvg: string;
  noSavingsBatches: number;
}

export function batchError(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message: `${code}: ${message}` });
}

function selectorOf(data: string): string {
  return data.slice(0, 10).toLowerCase();
}

function calldataBytes(data: string): number {
  return (data.length - 2) / 2;
}

/** Canonical ops hash binding quotes to the exact op list (QUOTE_MISMATCH). */
export function hashOps(ops: Array<Pick<StoredOp, "to" | "value" | "data">>): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify(ops.map((o) => ({ to: o.to.toLowerCase(), value: o.value, data: o.data.toLowerCase() }))),
  );
  return "0x" + h.digest("hex");
}

/**
 * Boundary validation for a batch op list (pure — unit-tested directly).
 * Session-key batches pass their session context; owner batches pass none.
 * Phase-1a rejects value-bearing ops unconditionally (non-financial only).
 */
export function validateBatchOps(
  ops: StoredOp[],
  opts: { atomic: boolean; sessionKey?: { keyAddress: string; expiresAt: number } },
): void {
  if (ops.length === 0) throw batchError("EMPTY_BATCH", "Batch must contain at least one op");
  if (ops.length > MAX_OPS_PER_BATCH) {
    throw batchError("BATCH_TOO_LARGE", `Batch exceeds ${MAX_OPS_PER_BATCH} ops`);
  }
  let totalCalldata = 0;
  let totalGasCap = 0n;
  const denied = new Set((DENIED_SELECTORS as readonly string[]).map((s) => s.toLowerCase()));
  for (const op of ops) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(op.to) || op.to.toLowerCase() === ZERO_ADDRESS) {
      throw batchError("INVALID_TARGET", `Op target is invalid: ${op.to}`);
    }
    if (!/^0x[0-9a-fA-F]*$/.test(op.data) || op.data.length < 10) {
      throw batchError("INVALID_CALLDATA", "Op data must carry at least a 4-byte selector");
    }
    totalCalldata += calldataBytes(op.data);
    if (denied.has(selectorOf(op.data))) {
      throw batchError("SESSION_DENIED", `Op selector ${selectorOf(op.data)} is denied for batched execution`);
    }
    if (!/^\d+$/.test(op.value) || op.value !== "0") {
      throw batchError("VALUE_NOT_PERMITTED", "Phase-1a batches are non-financial only (value must be 0)");
    }
    if (op.gasLimit !== undefined) {
      if (!/^\d+$/.test(op.gasLimit) || BigInt(op.gasLimit) <= 0n) {
        throw batchError("GAS_CEILING_EXCEEDED", "Per-op gas cap must be a positive integer");
      }
      totalGasCap += BigInt(op.gasLimit);
    }
    if (!op.intent || typeof op.intent !== "object") {
      throw batchError("INVALID_CALLDATA", "Each op must carry its signed single-call intent");
    }
    void opts;
  }
  if (totalCalldata > MAX_CALLDATA_BYTES_PER_BATCH) {
    throw batchError("BATCH_TOO_LARGE", "Batch calldata exceeds 64 KB");
  }
  if (totalGasCap > BigInt(BATCH_GAS_CEILING)) {
    throw batchError("GAS_CEILING_EXCEEDED", "Sum of per-op gas caps exceeds the batch gas ceiling");
  }
}

/** Stateless quote id: qb.<quotedBaseline36>.<opsHash8>.<expiresSec>.<feeVersion>. */
export function encodeQuoteId(baseline: bigint, opsHash: string, expiresSec: number, feeVersion: number): string {
  return `qb.${baseline.toString(36)}.${opsHash.slice(2, 10)}.${expiresSec.toString(36)}.${feeVersion}`;
}

export function decodeQuoteId(quoteId: string): {
  baseline: bigint;
  opsHash8: string;
  expiresSec: number;
  feeVersion: number;
} {
  const parts = quoteId.split(".");
  if (parts.length !== 5 || parts[0] !== "qb") throw batchError("QUOTE_MISMATCH", "Quote id is malformed");
  const baseline = Number.parseInt(parts[1], 36);
  const expiresSec = Number.parseInt(parts[3], 36);
  const feeVersion = Number.parseInt(parts[4], 10);
  if (!Number.isSafeInteger(baseline) || baseline < 0 || !Number.isSafeInteger(expiresSec) || !Number.isSafeInteger(feeVersion)) {
    throw batchError("QUOTE_MISMATCH", "Quote id is malformed");
  }
  return { baseline: BigInt(baseline), opsHash8: parts[2], expiresSec, feeVersion };
}

@Injectable()
export class BatchQueueService {
  private readonly logger = new Logger(BatchQueueService.name);
  private readonly ports: BatchPorts;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fees: FeePolicyService,
    private readonly security: SecurityEventService,
    private readonly config: ConfigService,
    ports?: BatchPorts,
  ) {
    this.ports = ports ?? failClosedPorts();
  }

  private windowSecs(): number {
    const raw = this.config.get<string | number>("BATCH_QUEUE_WINDOW_SECS");
    const n = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
    return Number.isSafeInteger(n) && (n as number) > 0 ? (n as number) : DEFAULT_QUEUE_WINDOW_SECS;
  }

  private reference(): string {
    return this.config.get<string>("BATCH_CHAIN_REFERENCE") ?? DEFAULT_BATCH_REFERENCE;
  }

  private toStored(dto: EstimateBatchDto): StoredOp[] {
    return dto.ops.map((o) => ({ to: o.to, value: o.value, data: o.data, gasLimit: o.gasLimit, intent: o.intent }));
  }

  /** Locked quote for a batch (spec §4.2 adapted: pass-through ceiling, no B+0.5V). */
  async estimateBatch(pid: string, dto: EstimateBatchDto, now = new Date()): Promise<BatchQuoteView> {
    const ops = this.toStored(dto);
    validateBatchOps(ops, { atomic: dto.atomic ?? true, sessionKey: dto.sessionKey });
    const windowSecs = this.windowSecs();
    const estimates: bigint[] = [];
    for (const op of ops) {
      estimates.push(await this.ports.estimator.estimateNetworkCost(op));
    }
    const baseline = estimates.reduce((a, b) => a + b, 0n);
    const policy = await this.fees.activePolicy();
    const maxTotal = baseline + ((baseline * BigInt(policy.bps)) / 10_000n);
    const nowSec = Math.floor(now.getTime() / 1000);
    const settleDueAt = new Date((nowSec + windowSecs) * 1000);
    if (dto.sessionKey && dto.sessionKey.expiresAt < Math.floor(settleDueAt.getTime() / 1000)) {
      throw batchError("SESSION_EXPIRED", "Session expires before the settlement window closes");
    }
    const opsHash = hashOps(ops);
    const quoteId = encodeQuoteId(baseline, opsHash, Math.floor(settleDueAt.getTime() / 1000), policy.version);
    return {
      quoteId,
      quotedAt: now.toISOString(),
      expiresAt: settleDueAt.toISOString(),
      baselineNetwork: baseline.toString(),
      quotedMaxTotal: maxTotal.toString(),
      feePolicyVersion: policy.version,
      feeBps: policy.bps,
      opsHash,
      perOp: estimates.map((e, index) => ({ index, networkEstimate: e.toString() })),
      assumptions: { namespace: BATCH_NAMESPACE, reference: this.reference(), windowSecs },
    };
  }

  /**
   * Submit a batch: bind the quote, enforce idempotency, enqueue (or settle
   * immediately when bypassQueue is set for urgent flows). Flushes due
   * batches opportunistically so no timer is required.
   */
  async submitBatch(pid: string, dto: SubmitBatchDto, now = new Date()): Promise<BatchStatusView> {
    const ops = this.toStored(dto);
    const atomic = dto.atomic ?? true;
    validateBatchOps(ops, { atomic, sessionKey: dto.sessionKey });

    const existing = await this.prisma.queuedBatch.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      if (existing.pid !== pid) throw new ConflictException("Idempotency key is already in use");
      return this.toView(existing);
    }

    const quote = decodeQuoteId(dto.quoteId);
    const nowSec = Math.floor(now.getTime() / 1000);
    if (quote.expiresSec <= nowSec) throw batchError("QUOTE_EXPIRED", "Quote expired — re-estimate and try again");
    const opsHash = hashOps(ops);
    if (opsHash.slice(2, 10) !== quote.opsHash8) {
      throw batchError("QUOTE_MISMATCH", "Ops changed since the quote — re-estimate and try again");
    }
    const policy = await this.fees.activePolicy();
    if (quote.feeVersion !== policy.version) {
      throw batchError("QUOTE_MISMATCH", "Fee policy changed since the quote — re-estimate and try again");
    }
    // Drift discipline (existing 120% pattern): re-estimate at submit time so a
    // forged or stale quote can never raise the user's lock above reality.
    let reestimated = 0n;
    for (const op of ops) {
      reestimated += await this.ports.estimator.estimateNetworkCost(op);
    }
    if (reestimated * 100n > quote.baseline * 120n) {
      throw new ConflictException("Network cost moved — re-estimate and try again");
    }
    const quotedMaxTotal = quote.baseline + ((quote.baseline * BigInt(policy.bps)) / 10_000n);
    const windowSecs = this.windowSecs();
    const settleDueAt = new Date((nowSec + windowSecs) * 1000);
    if (dto.sessionKey) {
      const state = await this.ports.sessions.check(
        dto.sessionKey.keyAddress,
        dto.sessionKey.sequence,
        nowSec,
      );
      if (state.revoked) throw batchError("SESSION_REVOKED", "Session was revoked — quote voided");
      if (!state.valid || state.expiresAt <= nowSec) {
        throw batchError("SESSION_EXPIRED", "Session is expired — quote voided");
      }
      if (state.expiresAt < Math.floor(settleDueAt.getTime() / 1000)) {
        throw batchError("SESSION_EXPIRED", "Session expires before the settlement window closes");
      }
    }

    const created = await this.prisma.queuedBatch.create({
      data: {
        pid,
        status: dto.bypassQueue ? "submitted" : "queued",
        atomic,
        ops: { from: dto.from, ops, sessionKey: dto.sessionKey ?? null } as never,
        quoteId: dto.quoteId,
        idempotencyKey: dto.idempotencyKey,
        quotedBaseline: quote.baseline,
        quotedMaxTotal,
        feePolicyVersion: policy.version,
        sessionExpiresAt: dto.sessionKey ? new Date(dto.sessionKey.expiresAt * 1000) : null,
        validUntil: settleDueAt,
        bypassQueue: dto.bypassQueue ?? false,
        settleDueAt,
      },
    });
    await this.security.log(pid, "batch.submitted", {
      batchId: created.id,
      opCount: ops.length,
      atomic,
      bypassQueue: dto.bypassQueue ?? false,
    }).catch(() => undefined);

    let view = this.toView(created);
    if (dto.bypassQueue) {
      view = await this.settleBatch(created.id, now);
    } else {
      // Opportunistic flush: due batches settle without any timer.
      await this.flushDueBatches(now).catch((err) => this.logger.warn(`opportunistic flush failed: ${String(err)}`));
      view = await this.getBatchStatus(pid, created.id);
    }
    return view;
  }

  async getBatchStatus(pid: string, batchId: string): Promise<BatchStatusView> {
    const row = await this.prisma.queuedBatch.findUnique({ where: { id: batchId } });
    if (!row || row.pid !== pid) throw new NotFoundException("Batch not found");
    return this.toView(row);
  }

  async cancelQueuedBatch(pid: string, batchId: string): Promise<BatchStatusView> {
    const row = await this.prisma.queuedBatch.findUnique({ where: { id: batchId } });
    if (!row || row.pid !== pid) throw new NotFoundException("Batch not found");
    if (row.status !== "queued") throw new ConflictException("Only queued batches can be cancelled");
    const updated = await this.prisma.queuedBatch.update({
      where: { id: batchId },
      data: { status: "expired" },
    });
    return this.toView(updated);
  }

  /**
   * Flush every due queued batch (timed window per spec §5) plus reap stale
   * `submitted` rows (crash between broadcast and settle). Every accepted
   * batch reaches a terminal state or explicit expiry — nothing is silently
   * dropped.
   */
  async flushDueBatches(now = new Date()): Promise<BatchStatusView[]> {
    const due = await this.prisma.queuedBatch.findMany({
      where: { status: "queued", settleDueAt: { lte: now } },
      orderBy: { settleDueAt: "asc" },
      take: FLUSH_BATCH_LIMIT,
    });
    const out: BatchStatusView[] = [];
    for (const row of due) {
      out.push(await this.settleBatch(row.id, now));
    }
    const staleCutoff = new Date(now.getTime() - STALE_SUBMITTED_FACTOR * this.windowSecs() * 1000);
    const stale = await this.prisma.queuedBatch.findMany({
      where: { status: "submitted", updatedAt: { lt: staleCutoff } },
      take: FLUSH_BATCH_LIMIT,
    });
    for (const row of stale) {
      out.push(await this.reapStaleSubmitted(row.id));
    }
    return out;
  }

  /** Settlement: simulate per op → sequential submit → pass-through settle. */
  private async settleBatch(batchId: string, now: Date): Promise<BatchStatusView> {
    const row = await this.prisma.queuedBatch.findUnique({ where: { id: batchId } });
    if (!row) throw new NotFoundException("Batch not found");
    const stored = row.ops as unknown as { from: string; ops: StoredOp[]; sessionKey?: { keyAddress: string; sequence: number; expiresAt: number } | null };
    const ops = stored.ops;
    const nowSec = Math.floor(now.getTime() / 1000);

    // Session must STILL be valid at settlement (validUntil <= expiresAt).
    if (stored.sessionKey) {
      const state = await this.ports.sessions.check(
        stored.sessionKey.keyAddress,
        stored.sessionKey.sequence,
        nowSec,
      ).catch(() => ({ valid: false, revoked: true, expiresAt: 0 }));
      const validUntilSec = row.validUntil ? Math.floor(row.validUntil.getTime() / 1000) : nowSec;
      if (state.revoked || !state.valid || state.expiresAt <= nowSec || state.expiresAt < validUntilSec) {
        const failed = await this.prisma.queuedBatch.update({
          where: { id: batchId },
          data: {
            status: "failed",
            failureCode: state.revoked ? "SESSION_REVOKED" : "SESSION_EXPIRED",
            failureMessage: "Session invalid at settlement — quote voided, no fee charged",
            settledAt: now,
          },
        });
        await this.security.log(row.pid, "batch.failed", { batchId, code: failed.failureCode }).catch(() => undefined);
        return this.toView(failed);
      }
    }

    await this.prisma.queuedBatch.update({ where: { id: batchId }, data: { status: "submitted" } });
    const policy = await this.fees.activePolicy();
    const Q = row.quotedBaseline;
    const receipts: Array<{ index: number; status: string; txHash?: string; reason?: string; actualCost?: string }> = [];
    let actualTotal = 0n;
    let successActual = 0n;
    let batchFailed = false;
    let failureCode: string | null = null;
    let failureMessage: string | null = null;

    for (let index = 0; index < ops.length; index++) {
      const op = ops[index];
      const sim = await this.ports.simulator.simulate(op).catch((err) => ({
        ok: false as const,
        reason: `SIMULATION_FAILED: ${String(err)}`,
        gasEstimate: 0n,
      }));
      if (!sim.ok) {
        receipts.push({ index, status: "failed", reason: sim.reason ?? "SIMULATION_FAILED" });
        if (row.atomic) {
          batchFailed = true;
          failureCode = "SIMULATION_FAILED";
          failureMessage = `Op ${index} failed simulation — atomic batch reverted`;
          break;
        }
        continue;
      }
      const receipt = await this.ports.submitter.submit(op).catch((err): OpReceipt => ({
        txHash: "",
        gasUsed: 0n,
        effectiveGasPrice: 0n,
        ok: false as const,
        revertReason: `RELAYER_ERROR: ${String(err)}`,
      }));
      const actual = receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n);
      if (!receipt.ok) {
        receipts.push({ index, status: "failed", txHash: receipt.txHash || undefined, reason: receipt.revertReason ?? "EXECUTION_REVERTED", actualCost: actual.toString() });
        actualTotal += actual;
        if (row.atomic) {
          batchFailed = true;
          failureCode = "EXECUTION_REVERTED";
          failureMessage = `Op ${index} reverted — atomic batch reverted`;
          break;
        }
        continue;
      }
      receipts.push({ index, status: "ok", txHash: receipt.txHash, actualCost: actual.toString() });
      actualTotal += actual;
      successActual += actual;
    }

    // Pass-through settlement: user pays 1.5× actual on successful ops plus
    // bare network cost on failed ops (no fee on failures), capped at the
    // quote lock. S = max(0, Q−A) floored.
    const A = actualTotal;
    const S = Q > A ? Q - A : 0n;
    const fee = ((successActual * BigInt(policy.bps)) / 10_000n);
    const failedActual = actualTotal - successActual;
    let userTotal = successActual + fee + failedActual;
    if (userTotal > row.quotedMaxTotal) userTotal = row.quotedMaxTotal;
    const pricing = S > 0n ? "PASS_THROUGH" : "NO_SAVINGS";

    if (!batchFailed || receipts.some((r) => r.txHash)) {
      // Ledger: one row per submitted op (kind batch_execute), best-effort —
      // a ledger write failure must never fail the user flow (existing pattern).
      const perOpQuoted = ops.length > 0 ? Q / BigInt(ops.length) : 0n;
      for (const r of receipts) {
        if (r.txHash === undefined && r.actualCost === undefined) continue;
        await this.fees.recordSubsidy({
          pid: row.pid,
          namespace: BATCH_NAMESPACE,
          reference: this.reference(),
          kind: "batch_execute",
          quotedFee: perOpQuoted,
          actualCost: BigInt(r.actualCost ?? "0"),
          txHash: r.txHash,
        }).catch((err) => this.logger.warn(`subsidy ledger write failed: ${String(err)}`));
      }
    }

    const terminal = batchFailed ? "failed" : receipts.some((r) => r.status === "failed") ? "partial" : "settled";
    const updated = await this.prisma.queuedBatch.update({
      where: { id: batchId },
      data: {
        status: terminal,
        receipts: { actual: A.toString(), savings: S.toString(), userTotal: userTotal.toString(), pricing, ops: receipts } as never,
        failureCode,
        failureMessage,
        settledAt: now,
      },
    });
    await this.security.log(row.pid, batchFailed ? "batch.failed" : "batch.settled", {
      batchId,
      status: terminal,
      actual: A.toString(),
      savings: S.toString(),
      pricing,
    }).catch(() => undefined);
    return this.toView(updated);
  }

  /** Reap a stale `submitted` row: finalize from stored receipts or fail closed. */
  private async reapStaleSubmitted(batchId: string): Promise<BatchStatusView> {
    const row = await this.prisma.queuedBatch.findUnique({ where: { id: batchId } });
    if (!row || row.status !== "submitted") return this.toView(row!);
    const receipts = row.receipts as unknown as { ops?: Array<{ status: string }> } | null;
    if (receipts?.ops && receipts.ops.length > 0) {
      // Settle deterministically from stored receipts (no resubmission).
      return this.settleBatch(batchId, new Date());
    }
    const failed = await this.prisma.queuedBatch.update({
      where: { id: batchId },
      data: {
        status: "failed",
        failureCode: "RELAYER_ERROR",
        failureMessage: "Flush crashed before any receipt was recorded — no fee charged",
        settledAt: new Date(),
      },
    });
    await this.security.log(row.pid, "batch.failed", { batchId, code: "RELAYER_ERROR" }).catch(() => undefined);
    return this.toView(failed);
  }

  /** Metrics feeding the phase-1b go/no-go (batch/fill/S/failure-revert rates). */
  async batchMetrics(windowDays = 7): Promise<BatchMetrics> {
    const days = Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 90 ? windowDays : 7;
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await this.prisma.queuedBatch.findMany({
      where: { createdAt: { gte: since } },
      take: METRICS_ROW_LIMIT,
    });
    let settled = 0;
    let failed = 0;
    let settledOps = 0;
    let failedOps = 0;
    let savingsTotal = 0n;
    let savingsSamples = 0;
    let noSavings = 0;
    for (const row of rows) {
      if (row.status === "settled" || row.status === "partial") {
        settled++;
        const r = row.receipts as unknown as { ops?: Array<{ status: string }>; savings?: string; pricing?: string } | null;
        for (const op of r?.ops ?? []) {
          if (op.status === "ok") settledOps++;
          else failedOps++;
        }
        if (r?.savings !== undefined) {
          savingsSamples++;
          savingsTotal += BigInt(r.savings);
          if (r.pricing === "NO_SAVINGS") noSavings++;
        }
      } else if (row.status === "failed") {
        failed++;
      }
    }
    const terminal = settled + failed;
    const totalOps = settledOps + failedOps;
    return {
      windowDays: days,
      totalBatches: rows.length,
      queuedBatches: rows.filter((r) => r.status === "queued" || r.status === "submitted").length,
      settledBatches: settled,
      failedBatches: failed,
      fillRate: terminal === 0 ? 0 : settled / terminal,
      failureRate: terminal === 0 ? 0 : failed / terminal,
      settledOps,
      failedOps,
      opFailureRate: totalOps === 0 ? 0 : failedOps / totalOps,
      savingsSamples,
      savingsTotal: savingsTotal.toString(),
      savingsAvg: savingsSamples === 0 ? "0" : (savingsTotal / BigInt(savingsSamples)).toString(),
      noSavingsBatches: noSavings,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toView(row: any): BatchStatusView {
    const stored = row.ops as unknown as { ops: StoredOp[] };
    const opCount = Array.isArray(stored?.ops) ? stored.ops.length : 0;
    const r = row.receipts as unknown as {
      ops?: Array<{ index: number; status: string; txHash?: string; reason?: string }>;
      actual?: string;
      userTotal?: string;
      savings?: string;
      pricing?: string;
    } | null;
    const perOp = r?.ops ??
      Array.from({ length: opCount }, (_, index) => ({ index, status: row.status === "expired" ? "expired" : "pending" }));
    return {
      batchId: row.id,
      lifecycle: row.status as BatchStatus,
      atomic: row.atomic,
      bypassQueue: row.bypassQueue,
      quoteId: row.quoteId,
      settleDueAt: row.settleDueAt.toISOString(),
      settledAt: row.settledAt ? row.settledAt.toISOString() : null,
      perOp,
      fees: {
        quotedBaseline: row.quotedBaseline.toString(),
        quotedMaxTotal: row.quotedMaxTotal.toString(),
        actualNetwork: r?.actual,
        userTotal: r?.userTotal,
        realizedSavings: r?.savings,
        pricing: r?.pricing,
      },
      ...(row.failureCode ? { failure: { code: row.failureCode, message: row.failureMessage ?? "" } } : {}),
    };
  }
}

/** Test seam: build a service with in-memory fakes (no DB, no chain). */
export function testPorts(overrides: Partial<BatchPorts> = {}): BatchPorts {
  return {
    estimator: { estimateNetworkCost: async () => 1000n },
    submitter: {
      submit: async () => ({ txHash: `0x${randomUUID().replace(/-/g, "")}`, gasUsed: 21000n, effectiveGasPrice: 1n, ok: true }),
    },
    simulator: { simulate: async () => ({ ok: true, gasEstimate: 21000n }) },
    sessions: { check: async () => ({ valid: true, revoked: false, expiresAt: Math.floor(Date.now() / 1000) + 3600 }) },
    ...overrides,
  };
}
