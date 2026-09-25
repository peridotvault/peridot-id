import { createHmac } from "node:crypto";
import { ConfigService } from "@nestjs/config";
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
    },
    fiatFeePolicy: {
      findFirst: jest.fn(async () => ({ version: 3, percentBps: 500, minIdr: 0n, maxIdr: 0n, active: true })),
      findUnique: jest.fn(async () => null),
    },
    identity: { findUnique: jest.fn(async () => null) },
    pidApp: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    pidAppFee: { findUnique: jest.fn(async () => null) },
    fiatLedgerEvent: {
      create: jest.fn(async (args: any) => ({ id: "e1", ...args.data })),
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
        findMany: jest.fn(async () => []),
        findFirst: jest.fn(async () => null),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    })),
  };
  const security = { log: jest.fn(async () => undefined) };
  const service = new FiatLedgerService(prisma as never, configStub(store), checkoutStub(paidAmount), security as never);
  return { service, prisma, created };
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
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => [
          { kind: "fiat_issue", amountIdr: 1_000_000n, direction: "in" },
        ]),
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
        findMany: jest.fn(async () => []),
      },
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    }));
    // transferConfirm rethrows BadRequestException from inside the txn.
    await expect(service.transferConfirm("live2dev@pid", "intent1")).rejects.toThrow("Insufficient");
    expect(created).toHaveLength(0);
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
        findFirst: jest.fn(async () => null),
        findMany: jest.fn(async () => [{ kind: "fiat_issue", amountIdr: 1_000_000n, direction: "in" }]),
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
    expect(prisma.fiatLedgerEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: "fiat.transfer.posted", targetPid: "live2dev@pid" }) }),
    );
  });
});
