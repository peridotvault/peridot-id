// ANT-456 — BackfillRunService regression suite.
//
// Proves: dry-run preview returns 202/preview with ZERO XP-state writes
// (B10); execution loops pages to done with cursor bookkeeping (resumable,
// idempotent page ops come from PolicyBackfillService); dryRun=false
// requires policyVersion (400) and the legacy migration env gate (503 —
// flag untouched, plan req 5); every request leaves a run row + audit rows.

import { ServiceUnavailableException } from "@nestjs/common";
import { BackfillRunService } from "./backfill-run.service";

interface RunRow {
  id: string;
  policyId: string;
  policyVersion: number;
  status: string;
  cursor: string | null;
  dryRun: boolean;
  processed: number;
  updated: number;
  actor: string;
  startedAt: Date;
  finishedAt: Date | null;
}

function setup(opts: { gate?: boolean; states?: Array<{ pid: string }>; activeId?: string | null } = {}) {
  const runs = new Map<string, RunRow>();
  let seq = 0;
  const prisma = {
    xpPolicyVersion: {
      findUnique: async ({ where }: { where: { id?: string; version?: number } }) => {
        if (where.version !== undefined) return where.version === 2 ? { id: "policy-b", version: 2 } : null;
        return where.id === "policy-b" ? { id: "policy-b", version: 2 } : null;
      },
    },
    backfillRun: {
      create: async ({ data }: { data: Partial<RunRow> }) => {
        seq++;
        const row: RunRow = {
          id: data.id ?? `run-${seq}`,
          policyId: data.policyId ?? "",
          policyVersion: data.policyVersion ?? 0,
          status: data.status ?? "queued",
          cursor: data.cursor ?? null,
          dryRun: data.dryRun ?? true,
          processed: data.processed ?? 0,
          updated: data.updated ?? 0,
          actor: data.actor ?? "",
          startedAt: new Date(),
          finishedAt: data.finishedAt ?? null,
        };
        runs.set(row.id, row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<RunRow> }) => {
        const row = runs.get(where.id);
        if (!row) throw new Error("run not found");
        Object.assign(row, data);
        return { ...row };
      },
      findMany: async () => [...runs.values()].map((r) => ({ ...r })),
    },
  };
  const stateWrites: Array<{ pid: string }> = [];
  const pages: Array<{ processed: number; updated: number; nextCursor: string | null; done: boolean }> = [
    { processed: 2, updated: 1, nextCursor: "b@pid", done: false },
    { processed: 1, updated: 1, nextCursor: null, done: true },
  ];
  const backfill = {
    migrationEnabled: jest.fn(() => opts.gate !== false),
    planBackfill: jest.fn(async (policyId: string) => ({ policyId, version: 2, totalStates: 3, stamped: 0, pending: 3 })),
    verifyBackfill: jest.fn(async () => ({ ok: true, mismatches: [], activeVersion: 2, unstamped: 0 })),
    runBackfill: jest.fn(async (actor: string, policyId: string, runOpts?: { cursor?: string }) => {
      void actor;
      void policyId;
      const page = runOpts?.cursor ? pages[1] : pages[0];
      return { policyId, version: 2, processed: page.processed, updated: page.updated, nextCursor: page.nextCursor, done: page.done };
    }),
  };
  const levels = {
    getActivePolicy: jest.fn(async () => {
      if (opts.activeId === null) throw new Error("no active policy");
      return { policy: { id: "policy-b", version: 2 } };
    }),
  };
  const audit: Array<{ pid: string; event: string }> = [];
  const security = { log: jest.fn(async (pid: string, event: string) => void audit.push({ pid, event })) };
  const service = new BackfillRunService(prisma as never, levels as never, backfill as never, security as never);
  return { service, runs, prisma, backfill, levels, security, audit, stateWrites };
}

describe("BackfillRunService", () => {
  beforeEach(() => jest.clearAllMocks());

  it("dry-run preview returns 202/preview with zero XP-state writes", async () => {
    const { service, runs, backfill, audit } = setup();
    const res = await service.requestRun("admin@pid", { dryRun: true, policyVersion: "2" });
    expect(res).toMatchObject({ status: "preview", cursor: null, policyId: "policy-b", policyVersion: "2" });
    expect(res.preview).toMatchObject({ pending: 3, reconcileOk: true });
    expect(backfill.runBackfill).not.toHaveBeenCalled();
    const rows = [...runs.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "preview", dryRun: true, actor: "admin@pid" });
    expect(audit.map((a) => a.event)).toEqual(["admin.xp.backfill.previewed"]);
  });

  it("dry-run without policyVersion previews the ACTIVE policy", async () => {
    const { service } = setup();
    const res = await service.requestRun("admin@pid", { dryRun: true });
    expect(res).toMatchObject({ status: "preview", policyId: "policy-b" });
  });

  it("execution without policyVersion is a 400 validation_error", async () => {
    const { service, runs } = setup();
    const err = await service.requestRun("admin@pid", { dryRun: false }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ error: "validation_error", message: expect.stringContaining("policyVersion") });
    expect(runs.size).toBe(0);
  });

  it("execution behind a closed migration gate is a 503 (flag untouched)", async () => {
    const { service, runs } = setup({ gate: false });
    const err = await service.requestRun("admin@pid", { dryRun: false, policyVersion: "2" }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(runs.size).toBe(0);
  });

  it("execution pages to done with cursor bookkeeping + completion audit", async () => {
    const { service, runs, audit } = setup({ gate: true });
    const res = await service.requestRun("admin@pid", { dryRun: false, policyVersion: "2" });
    expect(res).toMatchObject({ status: "done", cursor: null, processed: 3, updated: 2, reconcileOk: true });
    const rows = [...runs.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "done", dryRun: false, processed: 3, updated: 2 });
    expect(audit.map((a) => a.event)).toEqual(["admin.xp.backfill.run_requested", "admin.xp.backfill.run_completed"]);
  });

  it("execution resumes from a cursor", async () => {
    const { service, backfill } = setup({ gate: true });
    await service.requestRun("admin@pid", { dryRun: false, policyVersion: "2", cursor: "b@pid" });
    expect(backfill.runBackfill).toHaveBeenCalledTimes(1);
    expect(backfill.runBackfill.mock.calls[0][2]).toMatchObject({ cursor: "b@pid" });
  });

  it("listRuns returns the contract shape newest-first", async () => {
    const { service } = setup();
    await service.requestRun("admin@pid", { dryRun: true, policyVersion: "2" });
    const list = await service.listRuns(20);
    expect(list.runs).toHaveLength(1);
    expect(list.runs[0]).toMatchObject({ policyVersion: "2", status: "preview", actor: "admin@pid" });
    expect(list.runs[0]).toHaveProperty("runId");
  });
});
