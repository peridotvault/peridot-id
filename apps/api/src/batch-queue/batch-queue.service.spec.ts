// Phase-1a intent queue specs (ANT-762): validation, quote/settle math,
// idempotency, session-at-settlement, failure paths, flush, metrics.
// Follows the apps/api focused-spec pattern (mocked Prisma/fees, fake ports).
import { BatchQueueService, StoredOp, assertIntentSessionMatch, decodeQuoteId, encodeQuoteId, hashOps, testPorts, validateBatchOps, validateIntentEnvelope } from "./batch-queue.service";

const PID = "test-user@pid";
const FROM = "0x1111111111111111111111111111111111111111";
const TARGET_A = "0x2222222222222222222222222222222222222222";
const TARGET_B = "0x3333333333333333333333333333333333333333";
// transfer(address,uint256) — denied for batched execution (contract mirror).
const TRANSFER_DATA = "0xa9059cbb00000000000000000000000044444444444444444444444444444444444444440000000000000000000000000000000000000000000000000000000000000001";
const GAME_DATA = "0x123456780000000000000000000000000000000000000000000000000000000000000001";

const ACCOUNT = "0x15b4f164718fac7cfda7b60687aca4173c99aafc";

// Production envelope v1 (ANT-770): kind/version/account/chainId/call/auth,
// with call.* mirroring the op. Overrides win; pass `intent` explicitly to
// test malformed envelopes.
const envelopeFor = (
  to: string,
  value: string,
  data: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  version: 1,
  kind: "owner-execute-v3",
  account: ACCOUNT,
  chainId: "10143",
  call: { to, value, data },
  auth: {
    deadline: 2000000000,
    feePolicyVersion: 2,
    authenticatorData: "0x0404",
    clientDataJSON: "0x7b2274797065223a22776562617574686e2e676574227d",
    r: "0x0606060606060606060606060606060606060606060606060606060606060606",
    s: "0x0707070707070707070707070707070707070707070707070707070707070707",
  },
  ...over,
});

const op = (over: Partial<StoredOp> = {}): StoredOp => {
  const base: StoredOp = {
    to: TARGET_A,
    value: "0",
    data: GAME_DATA,
    intent: {},
    ...over,
  };
  if (!over.intent) {
    base.intent = envelopeFor(base.to, base.value, base.data);
  }
  return base;
};

interface Row {
  id: string;
  pid: string;
  status: string;
  atomic: boolean;
  ops: unknown;
  quoteId: string;
  idempotencyKey: string;
  quotedBaseline: bigint;
  quotedMaxTotal: bigint;
  feePolicyVersion: number;
  sessionExpiresAt: Date | null;
  validUntil: Date | null;
  bypassQueue: boolean;
  receipts: unknown;
  failureCode: string | null;
  failureMessage: string | null;
  settleDueAt: Date;
  settledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function harness(ports = testPorts()) {
  const store = new Map<string, Row>();
  let seq = 0;
  const prisma = {
    queuedBatch: {
      findUnique: jest.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        if (where.id) return store.get(where.id) ?? null;
        for (const row of store.values()) if (row.idempotencyKey === where.idempotencyKey) return row;
        return null;
      }),
      create: jest.fn(async ({ data }: { data: Partial<Row> }) => {
        seq++;
        const row = {
          id: `batch-${seq}`,
          pid: PID,
          status: "queued",
          atomic: true,
          receipts: null,
          failureCode: null,
          failureMessage: null,
          settledAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as Row;
        store.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = store.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
      findMany: jest.fn(async ({ where }: { where?: { status?: string; pid?: string; settleDueAt?: { lte: Date }; updatedAt?: { lt: Date }; createdAt?: { gte: Date } } }) => {
        let rows = [...store.values()];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        if (where?.pid) rows = rows.filter((r) => r.pid === where.pid);
        if (where?.settleDueAt) rows = rows.filter((r) => r.settleDueAt <= where.settleDueAt!.lte);
        if (where?.updatedAt) rows = rows.filter((r) => r.updatedAt < where.updatedAt!.lt);
        if (where?.createdAt) rows = rows.filter((r) => r.createdAt >= where.createdAt!.gte);
        return rows;
      }),
    },
  };
  const recordSubsidy = jest.fn(async () => undefined);
  const fees = {
    activePolicy: jest.fn(async () => ({ version: 2, bps: 5000 })),
    recordSubsidy,
  };
  const security = { log: jest.fn(async () => undefined) };
  const config = { get: jest.fn((key: string) => (key === "BATCH_QUEUE_WINDOW_SECS" ? 900 : undefined)) };
  const svc = new BatchQueueService(
    prisma as never,
    fees as never,
    security as never,
    config as never,
    ports,
  );
  return { svc, prisma, fees, recordSubsidy, store };
}

describe("validateBatchOps (boundary)", () => {
  it("rejects empty batches", () => {
    expect(() => validateBatchOps([], { atomic: true })).toThrow(expect.objectContaining({ message: expect.stringContaining("EMPTY_BATCH") }));
  });

  it("rejects >10 ops", () => {
    const ops = Array.from({ length: 11 }, () => op());
    expect(() => validateBatchOps(ops, { atomic: true })).toThrow(expect.objectContaining({ message: expect.stringContaining("BATCH_TOO_LARGE") }));
  });

  it("rejects zero-address and EOA-shaped targets", () => {
    expect(() => validateBatchOps([op({ to: "0x0000000000000000000000000000000000000000" })], { atomic: true }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("INVALID_TARGET") }));
    expect(() => validateBatchOps([op({ to: "not-an-address" })], { atomic: true }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("INVALID_TARGET") }));
  });

  it("rejects empty/short calldata", () => {
    expect(() => validateBatchOps([op({ data: "0x" })], { atomic: true }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("INVALID_CALLDATA") }));
  });

  it("rejects value-bearing ops in phase-1a", () => {
    expect(() => validateBatchOps([op({ value: "1" })], { atomic: true }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("VALUE_NOT_PERMITTED") }));
  });

  it("rejects denied selectors (transfer/approve family)", () => {
    expect(() => validateBatchOps([op({ data: TRANSFER_DATA })], { atomic: true }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("SESSION_DENIED") }));
  });

  it("rejects gas caps breaching the batch ceiling", () => {
    const ops = [op({ gasLimit: "29000000" }), op({ gasLimit: "2000000" })];
    expect(() => validateBatchOps(ops, { atomic: true }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("GAS_CEILING_EXCEEDED") }));
  });

  it("accepts a valid non-financial batch", () => {
    expect(() => validateBatchOps([op(), op({ to: TARGET_B })], { atomic: true })).not.toThrow();
  });
});

describe("quote → submit → settle (pass-through pricing)", () => {
  it("settles immediately on bypassQueue with quote-locked cap", async () => {
    const { svc, recordSubsidy } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const quote = await svc.estimateBatch(PID, { from: FROM, ops: [op(), op({ to: TARGET_B })], atomic: true }, t0);
    expect(BigInt(quote.baselineNetwork)).toBe(2000n);
    expect(BigInt(quote.quotedMaxTotal)).toBe(3000n); // 1.5× baseline, pure 50%
    const view = await svc.submitBatch(
      PID,
      { from: FROM, ops: [op(), op({ to: TARGET_B })], atomic: true, quoteId: quote.quoteId, idempotencyKey: "idem-1", bypassQueue: true },
      t0,
    );
    expect(view.lifecycle).toBe("settled");
    // Actual (2×21000 @1) exceeds quote → S=0, NO_SAVINGS, capped at quote lock.
    expect(view.fees.actualNetwork).toBe("42000");
    expect(view.fees.realizedSavings).toBe("0");
    expect(view.fees.pricing).toBe("NO_SAVINGS");
    expect(view.fees.userTotal).toBe("3000");
    expect(recordSubsidy).toHaveBeenCalledTimes(2);
    const firstCall = recordSubsidy.mock.calls[0] as unknown as Array<Record<string, unknown>>;
    expect(firstCall[0]).toMatchObject({ pid: PID, kind: "batch_execute" });
  });

  it("banks verified savings when actuals beat the quote", async () => {
    const ports = testPorts({
      estimator: { estimateNetworkCost: async () => 100_000n },
      submitter: {
        submit: async () => ({ txHash: "0xabc", gasUsed: 21000n, effectiveGasPrice: 1n, ok: true }),
      },
    });
    const { svc } = harness(ports);
    const t0 = new Date("2026-10-27T00:00:00Z");
    const ops = [op(), op({ to: TARGET_B })];
    const quote = await svc.estimateBatch(PID, { from: FROM, ops, atomic: true }, t0);
    const view = await svc.submitBatch(
      PID, { from: FROM, ops, atomic: true, quoteId: quote.quoteId, idempotencyKey: "idem-save", bypassQueue: true }, t0,
    );
    expect(view.lifecycle).toBe("settled");
    expect(view.fees.actualNetwork).toBe("42000");
    expect(view.fees.realizedSavings).toBe("158000"); // Q−A floored
    expect(view.fees.pricing).toBe("PASS_THROUGH");
    // User pays 1.5× actual (42000 + 21000 fee), never above the 300000 lock.
    expect(view.fees.userTotal).toBe("63000");
  });

  it("returns the original batch on duplicate idempotency keys", async () => {
    const ports = testPorts();
    const submitSpy = jest.spyOn(ports.submitter, "submit");
    const { svc } = harness(ports);
    const t0 = new Date("2026-10-27T00:00:00Z");
    const dto = { from: FROM, ops: [op()], atomic: true, quoteId: "", idempotencyKey: "idem-dup", bypassQueue: true };
    dto.quoteId = (await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0)).quoteId;
    const first = await svc.submitBatch(PID, dto, t0);
    const second = await svc.submitBatch(PID, dto, t0);
    expect(second.batchId).toBe(first.batchId);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched and expired quotes", async () => {
    const { svc } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const quote = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0);
    await expect(
      svc.submitBatch(PID, { from: FROM, ops: [op({ to: TARGET_B })], atomic: true, quoteId: quote.quoteId, idempotencyKey: "m1", bypassQueue: true }, t0),
    ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining("QUOTE_MISMATCH") }));
    const late = new Date(t0.getTime() + 901_000);
    await expect(
      svc.submitBatch(PID, { from: FROM, ops: [op()], atomic: true, quoteId: quote.quoteId, idempotencyKey: "m2", bypassQueue: true }, late),
    ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining("QUOTE_EXPIRED") }));
  });

  it("charges no fee on failed ops and surfaces actual cost", async () => {
    const ports = testPorts({
      estimator: { estimateNetworkCost: async () => 100_000n },
      submitter: {
        submit: async (o) =>
          o.to === TARGET_B
            ? { txHash: "0xbad", gasUsed: 5000n, effectiveGasPrice: 2n, ok: false, revertReason: "EXECUTION_REVERTED" }
            : { txHash: "0xgood", gasUsed: 21000n, effectiveGasPrice: 1n, ok: true },
      },
    });
    const { svc } = harness(ports);
    const t0 = new Date("2026-10-27T00:00:00Z");
    const ops = [op(), op({ to: TARGET_B })];
    const quote = await svc.estimateBatch(PID, { from: FROM, ops, atomic: false }, t0);
    const view = await svc.submitBatch(
      PID, { from: FROM, ops, atomic: false, quoteId: quote.quoteId, idempotencyKey: "idem-partial", bypassQueue: true }, t0,
    );
    expect(view.lifecycle).toBe("partial");
    // ok op: 21000 + 10500 fee; failed op: bare 10000 actual, no fee.
    expect(view.fees.userTotal).toBe(String(21000n + 10500n + 10000n));
  });

  it("fails atomic batches closed on first revert", async () => {
    const ports = testPorts({
      submitter: {
        submit: async () => ({ txHash: "0xbad", gasUsed: 5000n, effectiveGasPrice: 1n, ok: false, revertReason: "EXECUTION_REVERTED" }),
      },
    });
    const { svc } = harness(ports);
    const t0 = new Date("2026-10-27T00:00:00Z");
    const quote = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0);
    const view = await svc.submitBatch(
      PID, { from: FROM, ops: [op()], atomic: true, quoteId: quote.quoteId, idempotencyKey: "idem-atomic", bypassQueue: true }, t0,
    );
    expect(view.lifecycle).toBe("failed");
    expect(view.failure?.code).toBe("EXECUTION_REVERTED");
    // Halt-not-rollback (ANT-765 F3): the message must not promise a revert.
    expect(view.failure?.message).toMatch(/halted, prior submitted ops stand/);
  });

  it("reaps stale submitted rows fail-closed without resubmission (ANT-765 F1)", async () => {
    const ports = testPorts();
    const submitSpy = jest.spyOn(ports.submitter, "submit");
    const { svc, fees } = harness(ports);
    const t0 = new Date("2026-10-27T00:00:00Z");
    const quote = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0);
    // Crash settle between the `submitted` write and the terminal update.
    // Note: submitBatch consumes one activePolicy call for its version check
    // first, so the rejection lands on settleBatch's call.
    (fees.activePolicy as jest.Mock)
      .mockResolvedValueOnce({ version: 2, bps: 5000 })
      .mockRejectedValueOnce(new Error("db down"));
    await expect(
      svc.submitBatch(
        PID, { from: FROM, ops: [op()], atomic: true, quoteId: quote.quoteId, idempotencyKey: "idem-stuck", bypassQueue: true }, t0,
      ),
    ).rejects.toThrow("db down");
    expect(submitSpy).not.toHaveBeenCalled();
    // Past the 2x-window reaper horizon (wall-clock: the harness stamps
    // updatedAt with real time): failed closed, still no submission.
    const reaped = await svc.flushDueBatches(new Date(Date.now() + 2 * 900_000 + 1000));
    expect(reaped).toHaveLength(1);
    expect(reaped[0].lifecycle).toBe("failed");
    expect(reaped[0].failure?.code).toBe("RELAYER_ERROR");
    expect(reaped[0].failure?.message).toMatch(/no resubmission attempted/);
    expect(submitSpy).not.toHaveBeenCalled();
  });
});

describe("session validity at settlement", () => {
  it("fails closed when the session is revoked before settlement", async () => {
    const ports = testPorts({ sessions: { check: async () => ({ valid: false, revoked: true, expiresAt: 0 }) } });
    const { svc, recordSubsidy } = harness(ports);
    const t0 = new Date("2026-10-27T00:00:00Z");
    const sessionKey = { keyAddress: "0x5555555555555555555555555555555555555555", sequence: 7, expiresAt: Math.floor(t0.getTime() / 1000) + 3600 };
    // Quote-time check passes through the default-valid estimator ports? No:
    // revoked sessions fail at submit with the quote voided.
    await expect(
      svc.submitBatch(PID, {
        from: FROM, ops: [op()], atomic: true,
        quoteId: (await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true, sessionKey }, t0)).quoteId,
        idempotencyKey: "idem-revoked", bypassQueue: true, sessionKey,
      }, t0),
    ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining("SESSION_REVOKED") }));
    expect(recordSubsidy).not.toHaveBeenCalled();
  });

  it("rejects quotes when the session expires before the window closes", async () => {
    const { svc } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const sessionKey = { keyAddress: "0x5555555555555555555555555555555555555555", sequence: 7, expiresAt: Math.floor(t0.getTime() / 1000) + 60 };
    await expect(svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true, sessionKey }, t0))
      .rejects.toThrow(expect.objectContaining({ message: expect.stringContaining("SESSION_EXPIRED") }));
  });
});

describe("timed flush + cancel + metrics", () => {
  it("queues non-urgent batches and settles them once due", async () => {
    const { svc } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const quote = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0);
    const queued = await svc.submitBatch(
      PID, { from: FROM, ops: [op()], atomic: true, quoteId: quote.quoteId, idempotencyKey: "idem-q" }, t0,
    );
    expect(queued.lifecycle).toBe("queued");
    expect(await svc.flushDueBatches(t0)).toHaveLength(0);
    expect((await svc.getBatchStatus(PID, queued.batchId)).lifecycle).toBe("queued");
    const flushed = await svc.flushDueBatches(new Date(t0.getTime() + 901_000));
    expect(flushed).toHaveLength(1);
    expect(flushed[0].lifecycle).toBe("settled");
  });

  it("cancels queued batches fee-free and refuses to cancel settled ones", async () => {
    const { svc } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const q1 = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0);
    const queued = await svc.submitBatch(PID, { from: FROM, ops: [op()], atomic: true, quoteId: q1.quoteId, idempotencyKey: "idem-c1" }, t0);
    expect((await svc.cancelQueuedBatch(PID, queued.batchId)).lifecycle).toBe("expired");
    const q2 = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0);
    const settled = await svc.submitBatch(
      PID, { from: FROM, ops: [op()], atomic: true, quoteId: q2.quoteId, idempotencyKey: "idem-c2", bypassQueue: true }, t0,
    );
    await expect(svc.cancelQueuedBatch(PID, settled.batchId)).rejects.toThrow("Only queued batches can be cancelled");
  });

  it("reports batch/fill/S/failure metrics", async () => {
    const { svc } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const q = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0);
    await svc.submitBatch(PID, { from: FROM, ops: [op()], atomic: true, quoteId: q.quoteId, idempotencyKey: "idem-m1" }, t0);
    await svc.flushDueBatches(new Date(t0.getTime() + 901_000));
    const m = await svc.batchMetrics(7);
    expect(m.totalBatches).toBe(1);
    expect(m.settledBatches).toBe(1);
    expect(m.fillRate).toBe(1);
    expect(m.savingsSamples).toBe(1);
  });
});

describe("ANT-767 F2 pid-scoped flush + F4 hardening", () => {
  it("pid-scoped flush settles only the caller's batches", async () => {
    const { svc, store } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const due = new Date(t0.getTime() + 901_000);
    const otherPid = "other-user@pid";
    const qa = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true }, t0);
    const mine = await svc.submitBatch(
      PID, { from: FROM, ops: [op()], atomic: true, quoteId: qa.quoteId, idempotencyKey: "idem-mine" }, t0,
    );
    expect(mine.lifecycle).toBe("queued");
    // Second user's batch inserted directly (same harness store, different pid).
    const qb = await svc.estimateBatch(otherPid, { from: FROM, ops: [op()], atomic: true }, t0);
    const created = await (svc as unknown as { prisma: { queuedBatch: { create: (a: unknown) => Promise<{ id: string }> } } }).prisma.queuedBatch.create({
      data: {
        pid: otherPid,
        status: "queued",
        atomic: true,
        ops: { from: FROM, ops: [op()], sessionKey: null },
        quoteId: qb.quoteId,
        idempotencyKey: "idem-other",
        quotedBaseline: 1000n,
        quotedMaxTotal: 1500n,
        feePolicyVersion: 2,
        sessionExpiresAt: null,
        validUntil: due,
        bypassQueue: false,
        settleDueAt: due,
      },
    });
    void created;
    const flushedMine = await svc.flushDueBatches(due, PID);
    expect(flushedMine).toHaveLength(1);
    expect(flushedMine[0].lifecycle).toBe("settled");
    // Other user's batch is untouched by the pid-scoped flush.
    const otherRow = [...store.values()].find((r) => r.pid === otherPid)!;
    expect(otherRow.status).toBe("queued");
    // Global (admin/ops) flush still settles everything remaining.
    const flushedAll = await svc.flushDueBatches(due);
    expect(flushedAll).toHaveLength(1);
    expect([...store.values()].find((r) => r.pid === otherPid)!.status).toBe("settled");
  });

  it("binds the full ops hash and still accepts legacy 8-hex quote ids", async () => {
    const { svc } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const opsList = [op(), op({ to: TARGET_B })];
    const quote = await svc.estimateBatch(PID, { from: FROM, ops: opsList, atomic: true }, t0);
    const decoded = decodeQuoteId(quote.quoteId);
    expect(decoded.opsHashFull).toBe(hashOps(opsList).slice(2));
    // A tampered op (with its envelope rebuilt to mirror it, so it passes
    // the boundary) is still rejected by the full quote binding.
    const tamperedData = `${GAME_DATA}00`;
    const tampered = { ...opsList[1], data: tamperedData, intent: envelopeFor(TARGET_B, "0", tamperedData) };
    await expect(
      svc.submitBatch(PID, { from: FROM, ops: [opsList[0], tampered], atomic: true, quoteId: quote.quoteId, idempotencyKey: "idem-tamper" }, t0),
    ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining("QUOTE_MISMATCH") }));
    // Legacy 8-hex ids decode for quotes issued before the upgrade.
    const legacy = `qb.${(2000).toString(36)}.${hashOps(opsList).slice(2, 10)}.${Math.floor((t0.getTime() + 900_000) / 1000).toString(36)}.2`;
    expect(decodeQuoteId(legacy).opsHash8).toBe(hashOps(opsList).slice(2, 10));
    expect(decodeQuoteId(legacy).opsHashFull).toBeUndefined();
    expect(encodeQuoteId(2000n, hashOps(opsList), 123, 2).split(".")[2]).toHaveLength(64);
  });

  it("rejects oversized per-op intents with an explicit cap", () => {
    const bigIntent = { sig: "x".repeat(9 * 1024) };
    expect(() => validateBatchOps([op({ intent: bigIntent })], { atomic: true }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("INTENT_TOO_LARGE") }));
  });
});

describe("ANT-770 intent envelope validation (phase-1b owner spec)", () => {
  const sessionEnvelope = (seq: number, to = TARGET_A, data = GAME_DATA): Record<string, unknown> => ({
    version: 1,
    kind: "session-permission-v1",
    account: ACCOUNT,
    chainId: "10143",
    call: { to, value: "0", data },
    auth: {
      permissionId: "0x0707070707070707070707070707070707070707070707070707070707070707",
      deadline: 2000000000,
      seq,
      feePolicyVersion: 2,
      authenticatorData: "0x0404",
      clientDataJSON: "0x7b7d",
      r: "0x0606060606060606060606060606060606060606060606060606060606060606",
      s: "0x0707070707070707070707070707070707070707070707070707070707070707",
    },
  });

  it("accepts a valid v1 owner envelope mirroring the op", () => {
    const o = op();
    expect(() => validateIntentEnvelope(o.intent, o)).not.toThrow();
    expect(validateIntentEnvelope(o.intent, o)).toMatchObject({ kind: "owner-execute-v3", account: ACCOUNT.toLowerCase() });
  });

  it("defaults legacy kind-less intents to owner-execute-v3", () => {
    const o = op();
    const legacy = { ...(o.intent as Record<string, unknown>) };
    delete legacy["kind"];
    expect(validateIntentEnvelope(legacy, o).legacyDefaulted).toBe(true);
  });

  it("rejects unknown kinds fail-closed", () => {
    const o = op();
    const bad = { ...(o.intent as Record<string, unknown>), kind: "owner-execute-v99" };
    expect(() => validateIntentEnvelope(bad, o))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("Unknown intent kind") }));
  });

  it("rejects call/op mirror mismatches", () => {
    const o = op();
    const drifted = envelopeFor(TARGET_B, "0", o.data);
    expect(() => validateIntentEnvelope(drifted, o))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("must mirror the op") }));
  });

  it("rejects phase-1b kinds in phase-1a validation", () => {
    const v4 = envelopeFor(TARGET_A, "0", GAME_DATA, { kind: "owner-execute-v4" });
    expect(() => validateBatchOps([op({ intent: v4 })], { atomic: true }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("not permitted in phase-1a") }));
  });

  it("requires auth.seq binding on session intents", () => {
    const good = op({ intent: sessionEnvelope(7) });
    expect(() => assertIntentSessionMatch(good.intent, good, { sequence: 7 })).not.toThrow();
    const bad = op({ intent: sessionEnvelope(8) });
    expect(() => assertIntentSessionMatch(bad.intent, bad, { sequence: 7 }))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("seq does not match") }));
  });

  it("rejects session intents without permissionId", () => {
    const o = op();
    const noGrant = sessionEnvelope(7);
    delete (noGrant["auth"] as Record<string, unknown>)["permissionId"];
    expect(() => validateIntentEnvelope(noGrant, o))
      .toThrow(expect.objectContaining({ message: expect.stringContaining("permissionId") }));
  });

  it("submitBatch enforces the session seq cross-check", async () => {
    const { svc } = harness();
    const t0 = new Date("2026-10-27T00:00:00Z");
    const sessionKey = { keyAddress: "0x5555555555555555555555555555555555555555", sequence: 7, expiresAt: Math.floor(t0.getTime() / 1000) + 3600 };
    const mismatched = op({ intent: sessionEnvelope(9) });
    const quote = await svc.estimateBatch(PID, { from: FROM, ops: [op()], atomic: true, sessionKey }, t0);
    await expect(
      svc.submitBatch(PID, { from: FROM, ops: [mismatched], atomic: true, quoteId: quote.quoteId, idempotencyKey: "idem-seq", sessionKey }, t0),
    ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining("seq does not match") }));
  });
});