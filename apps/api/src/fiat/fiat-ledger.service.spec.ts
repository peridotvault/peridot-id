import { createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { encryptSecret } from "../common/secret-crypto";
import { FiatLedgerService } from "./fiat-ledger.service";

function configStub(store: Record<string, string> = {}) {
  const base: Record<string, string> = {
    PID_FIAT_LEDGER_ENABLED: "true",
    ...store,
  };
  return { get: (k: string, d?: string) => base[k] ?? d ?? "" } as unknown as ConfigService;
}

function checkoutStub(paidAmount: bigint | null = null) {
  return {
    checkOrderStatus: jest.fn(async () => ({
      paid: paidAmount !== null,
      paidAmount,
      expired: false,
      rawResponse: {},
    })),
  } as never;
}

function depositRow(over: Record<string, unknown> = {}) {
  return {
    id: "dp1",
    kind: "deposit",
    providerRef: "DP-1",
    providerStatus: "success",
    providerPaymentStatus: "success",
    amountIdr: 105_000n, // gross = 100k net + 5k fee
    feeIdr: 5_000n,
    netIdr: 100_000n,
    feePolicyVersion: 3,
    ledgerStatus: "pending",
    counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
    ...over,
  };
}

function setup(store?: Record<string, string>, paidAmount: bigint | null = 105_000n) {
  // ponytail: any-typed mock — shapes vary per test, strictness adds nothing here.
  const created: any[] = [];
  const prisma: any = {
    fiatProviderTransaction: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async (args: any) => ({ ...args.data })),
    },
    fiatLedgerEntry: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(async (args: any) => {
        const r = { id: `j${created.length}`, createdAt: new Date(), ...args.data };
        created.push(r);
        return r;
      }),
      update: jest.fn(async (args: any) => ({ id: "j0", ...args.data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    fiatFeePolicy: {
      findFirst: jest.fn(async () => ({ version: 3, percentBps: 500, minIdr: 0n, maxIdr: 0n, taxBps: 0, active: true })),
      findUnique: jest.fn(async () => null),
    },
    identity: { findUnique: jest.fn(async () => null) },
    pidApp: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    pidAppFee: { findUnique: jest.fn(async () => null) },
    fiatLedgerEvent: {
      create: jest.fn(async (args: any) => ({ id: "e1", ...args.data })),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async (args: any) => ({ id: "e1", ...args.data })),
      count: jest.fn(async () => 0),
    },
    $transaction: jest.fn(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(async (args: any) => {
          const r = { id: `j${created.length}`, createdAt: new Date(), ...args.data };
          created.push(r);
          return r;
        }),
        update: jest.fn(async (args: any) => ({ id: "j0", ...args.data })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findMany: jest.fn(async () => []),
        // Default null: transferConfirm's in-txn recheck and cancelIntent's
        // in-txn read see "no row" unless a test stages one (e.g. cross-pid
        // must read NotFound, never a staged created row).
        findFirst: jest.fn(async () => null),
        findUnique: jest.fn(async () => ({ id: "intent1", status: "created" })),
      },
      // In-txn delegates share the outer mocks so per-test overrides
      // (pidApp.findMany, fiatLedgerEvent.findFirst) apply inside the
      // atomic outbox path.
      pidApp: {
        findMany: (...args: any[]) => (prisma.pidApp.findMany as any)(...args),
      },
      fiatLedgerEvent: {
        findFirst: (...args: any[]) => (prisma.fiatLedgerEvent.findFirst as any)(...args),
        create: (...args: any[]) => (prisma.fiatLedgerEvent.create as any)(...args),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    })),
  };
  const security = { log: jest.fn(async () => undefined) };
  const service = new FiatLedgerService(prisma as never, configStub(store), checkoutStub(paidAmount), security as never);
  return { service, prisma, created, security };
}

describe("FiatLedgerService.issueForDeposit", () => {
  it("issues NET + fee legs once, idempotent on retry", async () => {
    const { service, prisma, created } = setup();
    prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(depositRow());
    await service.issueForDeposit("dp1", "sync");
    expect(created.filter((r: any) => r.kind === "fiat_issue" && r.status === "posted")).toHaveLength(1);
    expect(created.filter((r: any) => r.kind === "fiat_fee" && r.status === "posted")).toHaveLength(1);
    expect(created[0].idempotencyKey).toBe("IC-DP-1");
    expect(created[0].amountIdr).toBe(100_000n);

    // Retry: existing posted issue → no-op.
    const retry = setup();
    retry.prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(depositRow());
    retry.prisma.fiatLedgerEntry.findUnique.mockResolvedValueOnce({ idempotencyKey: "IC-DP-1", status: "posted" });
    await retry.service.issueForDeposit("dp1", "sync");
    expect(retry.created).toHaveLength(0);
  });

  it("skips blocked, non-checkout, and disabled rails without writing", async () => {
    for (const over of [
      { ledgerStatus: "blocked" },
      { counterparty: { channel: "va" } },
      { providerPaymentStatus: "pending", providerStatus: "processing" },
    ]) {
      const { service, prisma, created } = setup();
      prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(depositRow(over));
      await service.issueForDeposit("dp1", "sync");
      expect(created).toHaveLength(0);
    }
    const off = setup({ PID_FIAT_LEDGER_ENABLED: "false" });
    off.prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(depositRow());
    await off.service.issueForDeposit("dp1", "sync");
    expect(off.created).toHaveLength(0);
  });

  it("blocks the fiat row on amount mismatch", async () => {
    const { service, prisma, created } = setup({}, 100_000n); // paid != invoiced gross
    prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(depositRow());
    await service.issueForDeposit("dp1", "sync");
    expect(created).toHaveLength(0);
    expect(prisma.fiatProviderTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "dp1" } }),
    );
  });
});

describe("FiatLedgerService transfers", () => {
  it("allows sending to any user", async () => {
    const { service, prisma } = setup();
    await expect(service.transferInquiry("dev@pid", { amountIdr: "100", beneficiaryPid: "dev@pid" }))
      .rejects.toThrow("Cannot transfer to yourself");
    prisma.identity.findUnique.mockResolvedValueOnce({ pid: "rani@pid" });
    const inq = await service.transferInquiry("dev@pid", { amountIdr: "500000", beneficiaryPid: "rani@pid" });
    expect(inq.grossIdr).toBe("500000");
    expect(inq.beneficiaryPid).toBe("rani@pid");
  });

  it("allows user→app escrow inquiry and app→user confirm posts balanced legs", async () => {
    const { service, prisma, created } = setup();
    prisma.identity.findUnique.mockResolvedValueOnce({ pid: "live2dev@pid" });
    const inq = await service.transferInquiry("dev@pid", { amountIdr: "500000", beneficiaryPid: "live2dev@pid" });
    expect(inq.grossIdr).toBe("500000");
    expect(inq.feeIdr).toBe("25000"); // flat 5%
    expect(inq.netIdr).toBe("475000");

    // Confirm: fund the sender inside the mocked txn, then verify legs.
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", counterpartyPid: "live2dev@pid",
      entryGroup: inq.entryGroup, amountIdr: 500_000n, status: "created",
      feePolicyVersion: 3, counterparty: { remark: "deal" }, createdAt: new Date(),
    });
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(async (args: any) => {
          const r = { id: `j${created.length}`, createdAt: new Date(), ...args.data };
          created.push(r);
          return r;
        }),
        update: jest.fn(async (args: any) => ({ ...args.data })),
        // First in-txn read is transferConfirm's cancel-vs-confirm recheck
        // (created → proceeds); the head lookup in appendChained finds nothing.
        findFirst: jest.fn(async (): Promise<any> => null).mockResolvedValueOnce({ id: "intent1", status: "created" }),
        findMany: jest.fn(async () => [
          { kind: "fiat_issue", amountIdr: 1_000_000n, direction: "in" },
        ]),
      },
      pidApp: {
        findMany: (...args: any[]) => (prisma.pidApp.findMany as any)(...args),
      },
      fiatLedgerEvent: {
        findFirst: (...args: any[]) => (prisma.fiatLedgerEvent.findFirst as any)(...args),
        create: (...args: any[]) => (prisma.fiatLedgerEvent.create as any)(...args),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", entryGroup: inq.entryGroup,
      counterpartyPid: "live2dev@pid", amountIdr: 500_000n, status: "posted",
      counterparty: { feeQuote: "25000", netQuote: "475000" }, createdAt: new Date(),
    });
    const view = await service.transferConfirm("dev@pid", "intent1");
    expect(view.status).toBe("posted");
    const kinds = created.map((r: any) => `${r.kind}:${r.amountIdr}:${r.status}`);
    expect(kinds).toContain("fiat_transfer_in:475000:posted");
    expect(kinds).toContain("fiat_fee:25000:posted");
  });

  it("denies cross-pid confirm and cancel (no IDOR on intents)", async () => {
    const { service, prisma } = setup();
    // Intent belongs to dev@pid; attacker rani@pid must see NotFound, and
    // nothing may be written.
    prisma.fiatLedgerEntry.findFirst.mockResolvedValue(null);
    await expect(service.transferConfirm("rani@pid", "intent1")).rejects.toThrow("Transfer not found");
    await expect(service.cancelIntent("rani@pid", "intent1")).rejects.toThrow("Transfer not found");
    expect(prisma.fiatLedgerEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "intent1", pid: "rani@pid" }) }),
    );
  });

  it("rejects machine tokens without fiat:transfer scope on money paths (ANT-344 H3)", async () => {
    const { service, prisma } = setup();
    prisma.identity.findUnique.mockResolvedValue({ pid: "rani@pid" });
    // Unscoped legacy app token: fail closed before any DB write.
    await expect(
      service.transferInquiry(
        "dev@pid",
        { amountIdr: "500000", beneficiaryPid: "rani@pid" },
        "pidapp_x",
        { app: "pidapp_x" },
      ),
    ).rejects.toThrow("Machine token scope not authorized for transfers");
    // Wrong scope: also fail closed.
    await expect(
      service.transferConfirm("dev@pid", "intent1", { app: "pidapp_x", scope: "read" }),
    ).rejects.toThrow("Machine token scope not authorized for transfers");
    expect(prisma.fiatLedgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.fiatLedgerEntry.findFirst).not.toHaveBeenCalled();
  });

  it("allows machine tokens with fiat:transfer scope on money paths (ANT-344 H3)", async () => {
    const { service, prisma } = setup();
    prisma.identity.findUnique.mockResolvedValueOnce({ pid: "rani@pid" });
    const inq = await service.transferInquiry(
      "dev@pid",
      { amountIdr: "500000", beneficiaryPid: "rani@pid" },
      "pidapp_x",
      { app: "pidapp_x", scope: "fiat:transfer" },
    );
    expect(inq.grossIdr).toBe("500000");
    // User sessions (no app claim) are unaffected by the scope gate.
    prisma.identity.findUnique.mockResolvedValueOnce({ pid: "rani@pid" });
    const inq2 = await service.transferInquiry("dev@pid", { amountIdr: "500000", beneficiaryPid: "rani@pid" });
    expect(inq2.grossIdr).toBe("500000");
  });

  it("rejects confirm on insufficient balance without posting", async () => {
    const { service, prisma, created } = setup();
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", pid: "live2dev@pid", counterpartyPid: "s1@pid",
      entryGroup: "CT-X", amountIdr: 100_000n, status: "created",
      feePolicyVersion: 3, counterparty: {}, createdAt: new Date(),
    });
    // Empty posted balance → insufficient (no legs written).
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => ({ id: "intent1", status: "created" })),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    // transferConfirm rethrows BadRequestException from inside the txn.
    await expect(service.transferConfirm("live2dev@pid", "intent1")).rejects.toThrow("Insufficient");
    expect(created).toHaveLength(0);
  });

  it("rejects confirm when the intent was cancelled mid-race (no legs posted)", async () => {
    const { service, prisma, created } = setup();
    // Outer pre-read still sees created; the in-txn recheck sees cancelled.
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", counterpartyPid: "rani@pid",
      entryGroup: "CT-RACE", amountIdr: 100_000n, status: "created",
      feePolicyVersion: 3, counterparty: {}, createdAt: new Date(),
    });
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(async () => ({ count: 0 })),
        findMany: jest.fn(async () => [{ kind: "fiat_issue", amountIdr: 1_000_000n, direction: "in" }]),
        findFirst: jest.fn(async () => ({ id: "intent1", status: "cancelled" })),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));

    await expect(service.transferConfirm("dev@pid", "intent1")).rejects.toThrow("Transfer is closed");
    expect(created).toHaveLength(0);
  });

  it("counts the guard the same way replay does (fee/tax legs do not debit the owner)", async () => {
    const { service, prisma, created } = setup();
    // Replay balance after a 475k-net deposit with a 25k fee leg is 475k.
    // The old direction-only guard read 450k and wrongly rejected a 475k send.
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", counterpartyPid: "rani@pid",
      entryGroup: "CT-FEE", amountIdr: 475_000n, status: "created",
      feePolicyVersion: 3,
      counterparty: { feeQuote: "25000", taxQuote: "0", netQuote: "450000" },
      createdAt: new Date(),
    });
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(async (args: any) => {
          const r = { id: `j${created.length}`, createdAt: new Date(), ...args.data };
          created.push(r);
          return r;
        }),
        update: jest.fn(async (args: any) => ({ ...args.data })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        findFirst: jest.fn(async (): Promise<any> => null).mockResolvedValueOnce({ id: "intent1", status: "created" }),
        findMany: jest.fn(async () => [
          { kind: "fiat_issue", amountIdr: 475_000n, direction: "in" },
          { kind: "fiat_fee", amountIdr: 25_000n, direction: "out" },
        ]),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", entryGroup: "CT-FEE",
      counterpartyPid: "rani@pid", amountIdr: 475_000n, status: "posted",
      counterparty: { feeQuote: "25000", taxQuote: "0", netQuote: "450000" },
      createdAt: new Date(),
    });
    const view = await service.transferConfirm("dev@pid", "intent1");
    expect(view.status).toBe("posted");
    expect(created.map((r: any) => `${r.kind}:${r.amountIdr}`)).toContain("fiat_transfer_in:450000");
  });

  it("cancel takes the identity lock and leaves a posted intent untouched", async () => {
    const { service, prisma } = setup();
    const posted = {
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", entryGroup: "CT-P",
      counterpartyPid: "rani@pid", amountIdr: 10_000n, direction: "out",
      status: "posted", createdAt: new Date(),
    };
    const txMocks: any = {};
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        findFirst: jest.fn(async () => posted),
        updateMany: jest.fn(async () => {
          txMocks.updated = true;
          return { count: 0 };
        }),
      },
      $queryRaw: jest.fn(async (...a: any[]) => {
        txMocks.locked = true;
        return [];
      }),
      $executeRaw: jest.fn(async () => 1),
    }));
    const view = await service.cancelIntent("dev@pid", "intent1");
    expect(view.status).toBe("posted");
    expect(txMocks.locked).toBe(true);
    expect(txMocks.updated).toBeUndefined();
  });

  it("cancel claims a created intent with a guarded update", async () => {
    const { service, prisma } = setup();
    const row = (status: string) => ({
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", entryGroup: "CT-C",
      counterpartyPid: "rani@pid", amountIdr: 10_000n, direction: "out",
      status, createdAt: new Date(),
    });
    let claimed: any = null;
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        findFirst: jest.fn(async () => row("created")).mockResolvedValueOnce(row("created")).mockResolvedValueOnce(row("cancelled")),
        updateMany: jest.fn(async (args: any) => {
          claimed = args;
          return { count: 1 };
        }),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    const view = await service.cancelIntent("dev@pid", "intent1");
    expect(view.status).toBe("cancelled");
    expect(claimed).toMatchObject({ where: { id: "intent1", status: "created" } });
  });

  it("balance and journal flag truncated replays instead of silently rounding", async () => {
    const { service, prisma } = setup();
    const big = Array.from({ length: 5000 }, (_, i) => ({
      pid: "dev@pid", entryGroup: `G-${i % 10}`, kind: "fiat_issue",
      idempotencyKey: `K-${i}`, amountIdr: 1n, direction: "in", status: "posted", replaySeq: BigInt(i),
    }));
    prisma.fiatLedgerEntry.findMany.mockResolvedValueOnce(big).mockResolvedValueOnce([]);
    const b = await service.balance("dev@pid");
    expect(b.truncated).toBe(true);
    const small = [{
      pid: "dev@pid", entryGroup: "G-1", kind: "fiat_issue",
      idempotencyKey: "K-1", amountIdr: 100n, direction: "in", status: "posted", replaySeq: 1n,
    }];
    prisma.fiatLedgerEntry.findMany.mockResolvedValueOnce(small).mockResolvedValueOnce(small);
    const b2 = await service.balance("dev@pid");
    expect(b2.truncated).toBe(false);
    expect(b2.balanceIdr).toBe("100");
  });
});

describe("FiatLedgerService fees", () => {
  it("stacks the app fee on the global fee when an app context is given", async () => {
    const { service, prisma } = setup();
    prisma.pidApp.findUnique.mockResolvedValueOnce({ id: "app1", ownerPid: "live2dev@pid", isActive: true });
    prisma.pidAppFee.findUnique.mockResolvedValueOnce({ percentBps: 200, minIdr: 0n, maxIdr: 0n, enabled: true });
    // Mocked global policy is 5% uncapped → 50k; app fee 2% → 20k.
    const q = await service.quoteFees("pidapp_x", "transaction", 1_000_000n);
    expect(q.globalFee).toBe(50_000n);
    expect(q.appFee).toBe(20_000n);
    expect(q.appOwnerPid).toBe("live2dev@pid");
  });

  it("ignores a disabled or missing app fee", async () => {
    const { service, prisma } = setup();
    prisma.pidApp.findUnique.mockResolvedValueOnce({ id: "app1", ownerPid: "live2dev@pid", isActive: true });
    prisma.pidAppFee.findUnique.mockResolvedValueOnce({ percentBps: 200, minIdr: 0n, maxIdr: 0n, enabled: false });
    const q = await service.quoteFees("pidapp_x", "transaction", 1_000_000n);
    expect(q.appFee).toBe(0n);
  });

  it("waives the global fee for verified apps but keeps their own fee", async () => {
    const { service, prisma } = setup();
    prisma.pidApp.findUnique.mockResolvedValueOnce({ id: "app1", ownerPid: "live2dev@pid", isActive: true, isVerified: true });
    prisma.pidAppFee.findUnique.mockResolvedValueOnce({ percentBps: 200, minIdr: 0n, maxIdr: 0n, enabled: true });
    const q = await service.quoteFees("pidapp_x", "transaction", 1_000_000n);
    expect(q.globalFee).toBe(0n);
    expect(q.appFee).toBe(20_000n);
    expect(q.policyVersion).toBeGreaterThan(0);
  });

  it("keeps the global fee for unverified apps", async () => {
    const { service, prisma } = setup();
    prisma.pidApp.findUnique.mockResolvedValueOnce({ id: "app1", ownerPid: "live2dev@pid", isActive: true, isVerified: false });
    prisma.pidAppFee.findUnique.mockResolvedValueOnce({ percentBps: 0, minIdr: 0n, maxIdr: 0n, enabled: false });
    const q = await service.quoteFees("pidapp_x", "transaction", 1_000_000n);
    expect(q.globalFee).toBe(50_000n);
    expect(q.appFee).toBe(0n);
  });
});

describe("FiatLedgerService callbacks", () => {
  it("delivers a pending event with an HMAC signature", async () => {
    const { service, prisma } = setup();
    prisma.fiatLedgerEvent.findMany.mockResolvedValueOnce([
      { id: "e1", eventType: "fiat.transfer.posted", targetPid: "app@pid", targetUrl: "https://x/hook", payload: { hello: "world" }, attempts: 0 },
    ]);
    prisma.pidApp.findFirst.mockResolvedValueOnce({ webhookSecret: "s3cr3t" });
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const res = await service.dispatchEvents({});
    expect(res.sent).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://x/hook");
    expect(init.headers["X-Pid-Event"]).toBe("fiat.transfer.posted");
    const expected = "sha256=" + createHmac("sha256", "s3cr3t").update(init.body).digest("hex");
    expect(init.headers["X-Pid-Signature"]).toBe(expected);
    expect(prisma.fiatLedgerEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "delivered" }) }));
  });

  it("retries a failed delivery with backoff", async () => {
    const { service, prisma } = setup();
    prisma.fiatLedgerEvent.findMany.mockResolvedValueOnce([
      { id: "e2", eventType: "fiat.transfer.posted", targetPid: "app@pid", targetUrl: "https://x/hook", payload: {}, attempts: 0 },
    ]);
    prisma.pidApp.findFirst.mockResolvedValueOnce({ webhookSecret: "s" });
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: false, status: 500 }));

    const res = await service.dispatchEvents({});
    expect(res.failed).toBe(1);
    expect(prisma.fiatLedgerEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "pending", attempts: 1 }) }),
    );
  });

  it("signs with the secret of the app matching the event URL (not the first app)", async () => {
    const { service, prisma } = setup();
    prisma.fiatLedgerEvent.findMany.mockResolvedValueOnce([
      { id: "e3", eventType: "fiat.transfer.posted", targetPid: "app@pid", targetUrl: "https://b/hook", payload: { hello: "world" }, attempts: 0 },
    ]);
    // Owner holds two apps; the ownerPid-only lookup used to pick app A's
    // secret for app B's URL. The service must resolve by (ownerPid, URL).
    prisma.pidApp.findFirst.mockImplementationOnce(async (args: any) =>
      args?.where?.webhookUrl === "https://b/hook" ? { webhookSecret: "secret-B" } : { webhookSecret: "secret-A" },
    );
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const res = await service.dispatchEvents({});
    expect(res.sent).toBe(1);
    expect(prisma.pidApp.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ ownerPid: "app@pid", webhookUrl: "https://b/hook" }) }),
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    const expected = "sha256=" + createHmac("sha256", "secret-B").update(init.body).digest("hex");
    expect(init.headers["X-Pid-Signature"]).toBe(expected);
  });

  it("refuses unsigned dispatch when the target app/secret is gone", async () => {
    const { service, prisma } = setup();
    prisma.fiatLedgerEvent.findMany.mockResolvedValueOnce([
      { id: "e4", eventType: "fiat.transfer.posted", targetPid: "app@pid", targetUrl: "https://gone/hook", payload: {}, attempts: 0 },
    ]);
    prisma.pidApp.findFirst.mockResolvedValueOnce(null); // revoked/deleted app
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const res = await service.dispatchEvents({});
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled(); // never send with an empty-key HMAC
    expect(prisma.fiatLedgerEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "pending", attempts: 1 }) }),
    );
  });

  it("enqueues a callback when an app owns a transfer party", async () => {
    const { service, prisma } = setup();
    prisma.identity.findUnique.mockResolvedValueOnce({ pid: "live2dev@pid" });
    prisma.pidApp.findMany.mockResolvedValueOnce([{ ownerPid: "live2dev@pid", webhookUrl: "https://x/hook" }]);
    const inq = await service.transferInquiry("dev@pid", { amountIdr: "500000", beneficiaryPid: "live2dev@pid" });
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", counterpartyPid: "live2dev@pid",
      entryGroup: inq.entryGroup, amountIdr: 500_000n, status: "created",
      feePolicyVersion: 3, counterparty: {}, createdAt: new Date(),
    });
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(async (args: any) => ({ id: `j${Math.random()}`, createdAt: new Date(), ...args.data })),
        update: jest.fn(async (args: any) => ({ id: "intent1", ...args.data })),
        findFirst: jest.fn(async (): Promise<any> => null).mockResolvedValueOnce({ id: "intent1", status: "created" }),
        findMany: jest.fn(async () => [{ kind: "fiat_issue", amountIdr: 1_000_000n, direction: "in" }]),
      },
      // Atomic outbox: the confirm txn itself reads apps + writes events.
      pidApp: {
        findMany: (...args: any[]) => (prisma.pidApp.findMany as any)(...args),
      },
      fiatLedgerEvent: {
        findFirst: (...args: any[]) => (prisma.fiatLedgerEvent.findFirst as any)(...args),
        create: (...args: any[]) => (prisma.fiatLedgerEvent.create as any)(...args),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", entryGroup: inq.entryGroup,
      counterpartyPid: "live2dev@pid", amountIdr: 500_000n, status: "posted",
      direction: "out", counterparty: {}, createdAt: new Date(),
    });
    await service.transferConfirm("dev@pid", "intent1");
    // Written inside the same txn as the legs (no post-commit second write).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.fiatLedgerEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "fiat.transfer.posted",
          targetPid: "live2dev@pid",
          idempotencyKey: `${inq.entryGroup}:live2dev@pid`,
        }),
      }),
    );
  });

  it("skips a duplicate outbox enqueue on retried confirm", async () => {
    const { service, prisma } = setup();
    prisma.identity.findUnique.mockResolvedValueOnce({ pid: "live2dev@pid" });
    prisma.pidApp.findMany.mockResolvedValueOnce([{ ownerPid: "live2dev@pid", webhookUrl: "https://x/hook" }]);
    // A previous confirm already enqueued this movement's callback.
    prisma.fiatLedgerEvent.findFirst.mockResolvedValueOnce({ id: "e0" });
    const inq = await service.transferInquiry("dev@pid", { amountIdr: "500000", beneficiaryPid: "live2dev@pid" });
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", counterpartyPid: "live2dev@pid",
      entryGroup: inq.entryGroup, amountIdr: 500_000n, status: "created",
      feePolicyVersion: 3, counterparty: {}, createdAt: new Date(),
    });
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", entryGroup: inq.entryGroup,
      counterpartyPid: "live2dev@pid", amountIdr: 500_000n, status: "posted",
      direction: "out", counterparty: {}, createdAt: new Date(),
    });
    // Default tx mock has zero balance — stage funds for this confirm.
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(async (args: any) => ({ id: `j${Math.random()}`, createdAt: new Date(), ...args.data })),
        update: jest.fn(async (args: any) => ({ id: "intent1", ...args.data })),
        findFirst: jest.fn(async (): Promise<any> => null).mockResolvedValueOnce({ id: "intent1", status: "created" }),
        findMany: jest.fn(async () => [{ kind: "fiat_issue", amountIdr: 1_000_000n, direction: "in" }]),
      },
      pidApp: {
        findMany: (...args: any[]) => (prisma.pidApp.findMany as any)(...args),
      },
      fiatLedgerEvent: {
        findFirst: (...args: any[]) => (prisma.fiatLedgerEvent.findFirst as any)(...args),
        create: (...args: any[]) => (prisma.fiatLedgerEvent.create as any)(...args),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    await service.transferConfirm("dev@pid", "intent1");
    expect(prisma.fiatLedgerEvent.create).not.toHaveBeenCalled();
  });
});

describe("FiatLedgerService escrow fee operation", () => {
  it("escrow legs carry no app fee; a verified app also skips the global fee", async () => {
    const { service, prisma } = setup();
    // Verified app, no app-fee row for `escrow` → both fees zero (exact refund).
    prisma.pidApp.findUnique.mockResolvedValue({ id: "app1", ownerPid: "live2dev@pid", isActive: true, isVerified: true });
    prisma.pidAppFee.findUnique.mockResolvedValue(null);
    const verified = await service.quoteFees("pidapp_x", "escrow", 100_000n);
    expect(verified.globalFee).toBe(0n);
    expect(verified.appFee).toBe(0n);

    // Non-verified: the global fee still applies, but still no app fee.
    prisma.pidApp.findUnique.mockResolvedValue({ id: "app1", ownerPid: "live2dev@pid", isActive: true, isVerified: false });
    const publicApp = await service.quoteFees("pidapp_x", "escrow", 100_000n);
    expect(publicApp.globalFee).toBeGreaterThan(0n);
    expect(publicApp.appFee).toBe(0n);
  });
});

describe("FiatLedgerService adminAdjust (ANT-254 fiat_adjust writer)", () => {
  function adjustSetup(balanceIn: bigint) {
    const { service, prisma, created, security } = setup();
    prisma.identity.findUnique.mockImplementation(async ({ where }: any) =>
      ["dev@pid", "rani@pid"].includes(where.pid) ? { pid: where.pid } : null,
    );
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(async (args: any) => {
          const r = { id: `j${created.length}`, createdAt: new Date(), ...args.data };
          created.push(r);
          return r;
        }),
        update: jest.fn(async (args: any) => ({ ...args.data })),
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => [{ kind: "fiat_issue", amountIdr: balanceIn, direction: "in" }]),
      },
      pidApp: { findMany: jest.fn(async () => []) },
      fiatLedgerEvent: {
        findFirst: jest.fn(async () => null),
        create: jest.fn(async (args: any) => ({ id: "e1", ...args.data })),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    return { service, prisma, created, security };
  }

  it("posts a balanced out+in fiat_adjust pair", async () => {
    const { service, created } = adjustSetup(1_000_000n);
    const res = await service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "100000", reason: "duplicate payout reversal",
    });
    expect(res.entryGroup).toMatch(/^ADJ/);
    const legs = created.filter((r: any) => r.kind === "fiat_adjust");
    expect(legs).toHaveLength(2);
    const out = legs.find((r: any) => r.direction === "out");
    const inn = legs.find((r: any) => r.direction === "in");
    expect(out.pid).toBe("dev@pid");
    expect(out.amountIdr).toBe(100_000n);
    expect(inn.pid).toBe("rani@pid");
    expect(inn.amountIdr).toBe(100_000n);
    expect(out.entryGroup).toBe(inn.entryGroup);
    expect(out.status).toBe("posted");
  });

  it("rejects self-adjust, short reason, unknown identity, and insufficient balance", async () => {
    const { service } = adjustSetup(10_000n);
    await expect(service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "dev@pid", amountIdr: "100", reason: "self reversal reason",
    })).rejects.toThrow("must differ");
    await expect(service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "100", reason: "short",
    })).rejects.toThrow("reason is required");
    await expect(service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "ghost@pid", amountIdr: "100", reason: "unknown recipient case",
    })).rejects.toThrow("Identity not found");
    await expect(service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "50000", reason: "overdraft correction case",
    })).rejects.toThrow("Insufficient");
  });

  it("rejects a garbage requestId at the boundary", async () => {
    const { service } = adjustSetup(1_000_000n);
    await expect(service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "100", reason: "garbage key boundary",
      requestId: "not a key!!",
    })).rejects.toThrow("requestId must be");
  });

  it("keyed post writes deterministic idempotency keys", async () => {
    const { service, created } = adjustSetup(1_000_000n);
    const res = await service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "100000", reason: "duplicate payout reversal",
      requestId: "fix1",
    });
    expect(res.entryGroup).toBe("ADJ-fix1");
    const keys = created.filter((r: any) => r.kind === "fiat_adjust").map((r: any) => r.idempotencyKey).sort();
    expect(keys).toEqual(["ADJ-fix1-IN", "ADJ-fix1-OUT"]);
  });

  it("retried POST with the same requestId returns the original group (no second pair)", async () => {
    const { service, prisma } = adjustSetup(1_000_000n);
    prisma.fiatLedgerEntry.findUnique.mockResolvedValueOnce({
      id: "j0", entryGroup: "ADJ-dup1", kind: "fiat_adjust", pid: "dev@pid",
      counterpartyPid: "rani@pid", amountIdr: 100_000n, direction: "out", status: "posted",
    });
    const res = await service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "100000", reason: "duplicate payout reversal",
      requestId: "dup1",
    });
    expect(res.entryGroup).toBe("ADJ-dup1");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("same requestId with different amount → 409 (no silent overwrite)", async () => {
    const ctx = adjustSetup(1_000_000n);
    ctx.prisma.fiatLedgerEntry.findUnique.mockResolvedValueOnce({
      id: "j0", entryGroup: "ADJ-dup1", kind: "fiat_adjust", pid: "dev@pid",
      counterpartyPid: "rani@pid", amountIdr: 50_000n, direction: "out", status: "posted",
    });
    await expect(ctx.service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "100000", reason: "duplicate payout reversal",
      requestId: "dup1",
    })).rejects.toThrow("different adjustment");
  });

  it("unique-race on a keyed retry returns the winner's group (no second pair)", async () => {
    const { service, prisma, created } = setup();
    prisma.identity.findUnique.mockImplementation(async ({ where }: any) =>
      ["dev@pid", "rani@pid"].includes(where.pid) ? { pid: where.pid } : null,
    );
    prisma.fiatLedgerEntry.findUnique
      .mockResolvedValueOnce(null) // pre-check: nothing posted yet
      .mockResolvedValueOnce({ // race re-read: the concurrent POST won
        id: "j0", entryGroup: "ADJ-race1", kind: "fiat_adjust", pid: "dev@pid",
        counterpartyPid: "rani@pid", amountIdr: 100_000n, direction: "out", status: "posted",
      });
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("Unique constraint failed on the constraint"), { code: "P2002" }));
    const res = await service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "100000", reason: "duplicate payout reversal",
      requestId: "race1",
    });
    expect(res.entryGroup).toBe("ADJ-race1");
    expect(created).toHaveLength(0);
  });

  it("alerts (logger.error) when the audit sink fails — money stays moved", async () => {
    const { service, created, security } = adjustSetup(1_000_000n);
    (security.log as jest.Mock).mockRejectedValueOnce(new Error("sink down"));
    const errSpy = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    const res = await service.adminAdjust("admin@pid", {
      fromPid: "dev@pid", toPid: "rani@pid", amountIdr: "100000", reason: "duplicate payout reversal",
    });
    expect(res.entryGroup).toMatch(/^ADJ/);
    expect(created.filter((r: any) => r.kind === "fiat_adjust")).toHaveLength(2);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("AUDIT-SINK-FAILURE fiat.adjust"));
    errSpy.mockRestore();
  });
});

describe("FiatLedgerService ANT-286 wiring (secret-at-rest + app-token scope)", () => {
  const TEST_KEY = "ab".repeat(32);

  it("dispatches with a decrypted enc:v1: webhook secret (legacy plaintext still works)", async () => {
    const { service, prisma } = setup({ PID_SECRETS_ENC_KEY: TEST_KEY });
    const raw = "pidwh_testsecret123";
    const enc = encryptSecret(raw, TEST_KEY);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    prisma.fiatLedgerEvent.findMany.mockResolvedValueOnce([
      { id: "e-enc", eventType: "fiat.transfer.posted", targetPid: "app@pid", targetUrl: "https://x/hook", payload: { hello: "world" }, attempts: 0 },
    ]);
    prisma.pidApp.findFirst.mockResolvedValueOnce({ webhookSecret: enc });
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const res = await service.dispatchEvents({});
    expect(res.sent).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    const expected = "sha256=" + createHmac("sha256", raw).update(init.body).digest("hex");
    expect(init.headers["X-Pid-Signature"]).toBe(expected);
  });

  it("refuses dispatch when the envelope is undecryptable without the key (never empty-key HMAC)", async () => {
    const enc = encryptSecret("pidwh_secret", TEST_KEY);
    const { service, prisma } = setup({ PID_SECRETS_ENC_KEY: "" });
    prisma.fiatLedgerEvent.findMany.mockResolvedValueOnce([
      { id: "e-nokey", eventType: "fiat.transfer.posted", targetPid: "app@pid", targetUrl: "https://x/hook", payload: {}, attempts: 0 },
    ]);
    prisma.pidApp.findFirst.mockResolvedValueOnce({ webhookSecret: enc });
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200 }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    const res = await service.dispatchEvents({});
    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits fiat.transfer.app_token with app+scope on inquiry AND confirm", async () => {
    const { service, prisma, security } = setup();
    prisma.identity.findUnique.mockResolvedValue({ pid: "rani@pid" });
    const inq = await service.transferInquiry(
      "dev@pid",
      { amountIdr: "500000", beneficiaryPid: "rani@pid" },
      null,
      { app: "pidapp_x", scope: "fiat:transfer" },
    );
    expect(security.log).toHaveBeenCalledWith(
      "dev@pid",
      "fiat.transfer.app_token",
      expect.objectContaining({ app: "pidapp_x", scope: "fiat:transfer", phase: "inquiry" }),
    );

    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", counterpartyPid: "rani@pid",
      entryGroup: inq.entryGroup, amountIdr: 500_000n, status: "created",
      feePolicyVersion: 3, counterparty: {}, createdAt: new Date(),
    });
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn({
      fiatLedgerEntry: {
        create: jest.fn(async (args: any) => ({ id: "j1", createdAt: new Date(), ...args.data })),
        update: jest.fn(async (args: any) => ({ id: "intent1", ...args.data })),
        findFirst: jest.fn(async () => ({ id: "intent1", status: "created" })),
        findMany: jest.fn(async () => [{ kind: "fiat_issue", amountIdr: 1_000_000n, direction: "in" }]),
      },
      pidApp: { findMany: jest.fn(async () => []) },
      fiatLedgerEvent: { findFirst: jest.fn(async () => ({ id: "e0" })), create: jest.fn(async () => ({})) },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    prisma.fiatLedgerEntry.findFirst.mockResolvedValueOnce({
      id: "intent1", kind: "fiat_transfer_out", pid: "dev@pid", counterpartyPid: "rani@pid",
      entryGroup: inq.entryGroup, amountIdr: 500_000n, status: "posted",
      direction: "out", counterparty: {}, createdAt: new Date(),
    });
    await service.transferConfirm("dev@pid", "intent1", { app: "pidapp_x", scope: "fiat:transfer" });
    expect(security.log).toHaveBeenCalledWith(
      "dev@pid",
      "fiat.transfer.app_token",
      expect.objectContaining({ app: "pidapp_x", scope: "fiat:transfer", phase: "confirm" }),
    );
  });
});

