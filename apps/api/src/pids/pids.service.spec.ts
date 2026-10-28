// ANT-804 D1-D3 focused contract tests (no DB — mocked delegates).
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PidsService } from "./pids.service";

function setup() {
  const store: Record<string, any> = { receipts: new Map(), reports: new Map(), reviews: [] as any[], audits: [] as any[] };
  const prisma: any = {
    pidClaimReceipt: {
      findUnique: jest.fn(async ({ where }: any) => store.receipts.get(where.idempotencyKey) ?? null),
      create: jest.fn(async ({ data }: any) => {
        if (store.receipts.has(data.idempotencyKey)) {
          const e: any = new Error("unique"); e.code = "P2002"; throw e;
        }
        const row = { ...data, createdAt: new Date(Date.now()) };
        store.receipts.set(data.idempotencyKey, row);
        return row;
      }),
      findMany: jest.fn(async () => []),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      // ANT-826 D2.1: real per-actor counting over the in-memory store so the
      // bulk regression (11 same-actor claims → flag) exercises the new path.
      // Old per-pid code fails this test (each pid appears once).
      count: jest.fn(async ({ where }: any = {}) => {
        let rows = [...store.receipts.values()];
        if (where?.actorRef !== undefined) rows = rows.filter((r) => r.actorRef === where.actorRef);
        else if (where?.pid !== undefined) rows = rows.filter((r) => r.pid === where.pid);
        if (where?.createdAt?.gte) rows = rows.filter((r) => r.createdAt >= where.createdAt.gte);
        return rows.length;
      }),
    },
    pidTakedownReport: {
      create: jest.fn(async ({ data, select }: any) => {
        const row = { id: `rep-${store.reports.size + 1}`, createdAt: new Date(Date.now()), ...data };
        store.reports.set(row.id, row);
        void select;
        return { id: row.id, slaRespondBy: row.slaRespondBy };
      }),
      findUnique: jest.fn(async ({ where }: any) => store.reports.get(where.id) ?? null),
      findFirst: jest.fn(async ({ where }: any = {}) => {
        let rows = [...store.reports.values()];
        if (where?.normalizedHandle !== undefined) rows = rows.filter((r) => r.normalizedHandle === where.normalizedHandle);
        if (where?.state?.in) rows = rows.filter((r) => (where.state.in as string[]).includes(r.state));
        return rows[0] ?? null;
      }),
      count: jest.fn(async ({ where }: any = {}) => {
        let rows = [...store.reports.values()];
        if (where?.reporterPid !== undefined) rows = rows.filter((r) => r.reporterPid === where.reporterPid);
        if (where?.createdAt?.gte) rows = rows.filter((r) => r.createdAt >= where.createdAt.gte);
        return rows.length;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const cur = store.reports.get(where.id);
        const next = { ...cur };
        for (const [k, v] of Object.entries(data)) {
          next[k] = v && typeof v === "object" && "increment" in (v as any) ? cur[k] + (v as any).increment : v;
        }
        store.reports.set(where.id, next);
        return next;
      }),
    },
    pidHandleReview: {
      create: jest.fn(async ({ data }: any) => { store.reviews.push(data); return data; }),
      findMany: jest.fn(async () => []),
    },
    claimTicket: { findUnique: jest.fn(async () => ({ provider: "google", providerUserId: "u1" })) },
    identity: {
      findUnique: jest.fn(async () => null),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    identityCredential: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
    profile: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    securityEvent: { findMany: jest.fn(async () => []) },
  };
  const claims: any = { claim: jest.fn(async (_t: string, h: string) => ({ pid: `${h}@pid` })) };
  const security: any = { log: jest.fn(async () => undefined) };
  const svc = new PidsService(prisma, claims, security);
  return { svc, prisma, claims, security, store };
}

describe("PidsService D1 claim contract (§6.1)", () => {
  it("201 {handle,normalizedHandle,claimedAt} with canonical normalization", async () => {
    const { svc, claims } = setup();
    const out = await svc.claimContract("ct_1", "  ALICE​ ", "k-1");
    expect(out).toEqual({ handle: "alice", normalizedHandle: "alice", claimedAt: expect.any(String) });
    expect(claims.claim).toHaveBeenCalledWith("ct_1", "alice");
  });

  it("400 HANDLE_INVALID for bad handles (no 500)", async () => {
    const { svc, claims } = setup();
    for (const bad of ["", "ab", "has space", "UPPER-TOO-LONG-HANDLE-12345"]) {
      try { await svc.claimContract("ct_1", bad, `k-${bad}`); fail("should throw"); }
      catch (e: any) {
        expect(e).toBeInstanceOf(BadRequestException);
        expect((e.getResponse() as any).code).toBe("HANDLE_INVALID");
      }
    }
    expect(claims.claim).not.toHaveBeenCalled();
  });

  it("same idempotencyKey + same handle replays the original 201 (claim runs once)", async () => {
    const { svc, claims } = setup();
    const first = await svc.claimContract("ct_1", "bob", "k-bob");
    const second = await svc.claimContract("ct_1", "BOB", "k-bob");
    expect(second).toEqual(first);
    expect(claims.claim).toHaveBeenCalledTimes(1);
  });

  it("same idempotencyKey + different handle → 409 (never a second claim)", async () => {
    const { svc, claims } = setup();
    await svc.claimContract("ct_1", "carol", "k-c");
    try { await svc.claimContract("ct_1", "carol2", "k-c"); fail("should throw"); }
    catch (e: any) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e.getResponse() as any).code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(claims.claim).toHaveBeenCalledTimes(1);
  });

  it("claim conflict maps to stable 409 HANDLE_TAKEN (AC-D1.1/D1.3, race never 500)", async () => {
    const { svc, claims } = setup();
    claims.claim.mockRejectedValueOnce(new ConflictException("PID already taken"));
    try { await svc.claimContract("ct_1", "dave", "k-d"); fail("should throw"); }
    catch (e: any) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e.getResponse() as any).code).toBe("HANDLE_TAKEN");
    }
  });
});

describe("PidsService D2 status + reports (§6.2)", () => {
  it("status available → claimed → under_review (never reserved)", async () => {
    const { svc, prisma } = setup();
    expect((await svc.handleStatus("ghost")).state).toBe("available");
    prisma.identity.findUnique.mockResolvedValueOnce({ pid: "heidi@pid", status: "active" });
    expect((await svc.handleStatus("heidi")).state).toBe("claimed");
    prisma.identity.findUnique.mockResolvedValueOnce({ pid: "ivan@pid", status: "active" });
    prisma.pidTakedownReport.findFirst.mockResolvedValueOnce({ id: "rep-9" });
    const st = await svc.handleStatus("ivan");
    expect(st.state).toBe("under_review");
    expect(st.reasonCode).toBe("takedown_review");
  });

  it("createReport → 202 shape with 3-business-day SLA", async () => {
    const { svc } = setup();
    const before = Date.now();
    const out = await svc.createReport("r@pid", { handle: "mallory", grounds: "trademark", evidence: "owns the mark 1234567890", reporterContact: "legal@corp.dev" });
    expect(out.reportId).toBe("rep-1");
    const sla = new Date(out.slaRespondBy).getTime();
    expect(sla - before).toBeGreaterThan(0);
    expect(sla - before).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
  });

  it("appeal: exactly 1x within 14 days (AC-D2.4)", async () => {
    const { svc, store } = setup();
    store.reports.set("rep-a", {
      id: "rep-a", handle: "nina", normalizedHandle: "nina", state: "decided",
      decision: "keep", decidedAt: new Date(), appealCount: 0, reporterPid: "r@pid",
    });
    const ok = await svc.appealReport("r@pid", "rep-a");
    expect(ok.state).toBe("triaging");
    try { await svc.appealReport("r@pid", "rep-a"); fail("should throw"); }
    catch (e: any) { expect(e).toBeInstanceOf(ConflictException); }
  });

  it("decide release snapshots history, frees the handle, retains audit (AC-D2.3)", async () => {
    const { svc, store, prisma } = setup();
    store.reports.set("rep-r", {
      id: "rep-r", handle: "oscar", normalizedHandle: "oscar", state: "triaging", appealCount: 0,
    });
    const out = await svc.decideReport("admin@pid", "rep-r", { decision: "release", rationale: "clear trademark squat" });
    expect(out).toMatchObject({ reportId: "rep-r", state: "closed", decision: "release" });
    expect(prisma.identity.deleteMany).toHaveBeenCalledWith({ where: { pid: "oscar@pid" } });
    expect(store.reports.get("rep-r").auditSnapshot).toMatchObject({ pid: "oscar@pid" });
  });
});

describe("PidsService D2.1 bulk flag per-actor (ANT-826)", () => {
  function handle(n: number): string {
    // 3-20 lowercase alnum handles: bulk000 … bulk010.
    return `bulk${String(n).padStart(3, "0")}`;
  }

  it("11 claims same actor → 1 PidHandleReview reason=bulk (fails on old per-pid code)", async () => {
    const { svc, store } = setup();
    for (let i = 0; i < 11; i++) {
      const out = await svc.claimContract("ct-same-actor", handle(i), `k-bulk-${i}`);
      expect(out.claimedAt).toEqual(expect.any(String));
    }
    expect(store.reviews.length).toBe(1);
    expect(store.reviews[0]).toMatchObject({ reason: "bulk", actorRef: "google:u1" });
    expect((store.reviews[0].metadata as any).recent24h).toBe(11);
    // Receipts carry the actor for per-actor counting.
    for (const r of store.receipts.values()) expect(r.actorRef).toBe("google:u1");
  });

  it("10 claims same actor → no flag (threshold is >10)", async () => {
    const { svc, store } = setup();
    for (let i = 0; i < 10; i++) {
      await svc.claimContract("ct-same-actor", handle(i), `k-bulk10-${i}`);
    }
    expect(store.reviews.length).toBe(0);
  });

  it("legit single claim still 201s and stores actorRef (advisory only)", async () => {
    const { svc, store } = setup();
    const out = await svc.claimContract("ct-same-actor", "alice", "k-legit-1");
    expect(out).toEqual({ handle: "alice", normalizedHandle: "alice", claimedAt: expect.any(String) });
    expect(store.reviews.length).toBe(0);
    expect(store.receipts.get("k-legit-1").actorRef).toBe("google:u1");
  });
});

describe("PidsService F5 takedown hardening (ANT-826)", () => {
  it("throttles the 6th report/hour per reporter with 429 (first 5 pass)", async () => {
    const { svc } = setup();
    for (let i = 0; i < 5; i++) {
      await svc.createReport("r@pid", { handle: "mallory", grounds: "trademark", evidence: "owns the mark 1234567890", reporterContact: "legal@corp.dev" });
    }
    try {
      await svc.createReport("r@pid", { handle: "mallory", grounds: "trademark", evidence: "owns the mark 1234567890", reporterContact: "legal@corp.dev" });
      fail("should throttle");
    } catch (e: any) {
      expect(e.getStatus?.() ?? e.status).toBe(429);
    }
  });

  it("rejects unverified reporterContact before the SLA clock starts (400)", async () => {
    const { svc, store } = setup();
    const before = store.reports.size;
    try {
      await svc.createReport("r@pid", { handle: "mallory", grounds: "trademark", evidence: "owns the mark 1234567890", reporterContact: "not-a-contact" });
      fail("should throw");
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
    }
    expect(store.reports.size).toBe(before);
  });

  it("stores reporterContactVerifiedAt and starts the SLA from verification", async () => {
    const { svc, store } = setup();
    const before = Date.now();
    const out = await svc.createReport("r@pid", { handle: "mallory", grounds: "trademark", evidence: "owns the mark 1234567890", reporterContact: "legal@corp.dev" });
    const row = [...store.reports.values()].find((r: any) => r.id === out.reportId);
    expect(row.reporterContactVerifiedAt).toBeInstanceOf(Date);
    expect(new Date(out.slaRespondBy).getTime()).toBeGreaterThanOrEqual(row.reporterContactVerifiedAt.getTime());
    expect(new Date(out.slaRespondBy).getTime() - before).toBeGreaterThan(0);
  });

  it("freezes claims while the handle is under_review (409 HANDLE_UNDER_REVIEW)", async () => {
    const { svc, store } = setup();
    store.reports.set("rep-f", {
      id: "rep-f", handle: "frozen", normalizedHandle: "frozen", state: "triaging",
      appealCount: 0, reporterPid: "r@pid", createdAt: new Date(),
    });
    try {
      await svc.claimContract("ct-x", "frozen", "k-frozen-1");
      fail("should freeze");
    } catch (e: any) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e.getResponse() as any).code).toBe("HANDLE_UNDER_REVIEW");
    }
  });

  it("freezes transfers into a handle that is itself under_review", async () => {
    const { svc, store } = setup();
    store.reports.set("rep-t1", {
      id: "rep-t1", handle: "squat", normalizedHandle: "squat", state: "triaging",
      appealCount: 0, createdAt: new Date(),
    });
    store.reports.set("rep-t2", {
      id: "rep-t2", handle: "other", normalizedHandle: "other", state: "triaging",
      appealCount: 0, createdAt: new Date(),
    });
    try {
      await svc.decideReport("admin@pid", "rep-t1", { decision: "transfer", rationale: "transfer to reviewed handle", targetPid: "other@pid" });
      fail("should freeze");
    } catch (e: any) {
      expect(e).toBeInstanceOf(ConflictException);
      expect((e.getResponse() as any).code).toBe("HANDLE_UNDER_REVIEW");
    }
  });
});
