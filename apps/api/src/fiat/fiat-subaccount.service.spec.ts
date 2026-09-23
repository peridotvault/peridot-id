import { ConfigService } from "@nestjs/config";
import { calcServiceFee, parseIdrStrict, type DokuCheckoutClient, type SubAccountProvider } from "@peridotvault/pid-payments";
import { FiatSubAccountService } from "./fiat-subaccount.service";

function configStub(store: Record<string, string> = {}) {
  const base: Record<string, string> = { ...store };
  return { get: (k: string, d?: string) => base[k] ?? d ?? "" } as unknown as ConfigService;
}

function sacStub() {
  return {
    name: "doku-sub-account",
    register: jest.fn(async (i: { partnerReferenceNo: string }) => ({
      profileId: `PROF-${i.partnerReferenceNo}`,
      accounts: [
        { type: "DOKU_MERCHANT_IDR", currency: "IDR", accountNo: "1140340010" },
        { type: "DOKU_MERCHANT_PENDING_IDR", currency: "IDR", accountNo: "1140340011" },
      ],
      vaNumber: "888001140340010",
      rawResponse: { responseCode: "2000000", profileId: `PROF-${i.partnerReferenceNo}` },
    })),
    balance: jest.fn(async (profileId: string) => ({
      profileId,
      accounts: [{ type: "DOKU_MERCHANT_IDR", currency: "IDR", accountNo: "1140340010", available: "150000.00", reserved: "0.00" }],
      rawResponse: {},
    })),
    history: jest.fn(async () => ({ items: [], rawResponse: {} })),
    txStatus: jest.fn(async (ref: string) => ({ partnerReferenceNo: ref, latestTransactionStatus: "00", rawResponse: {} })),
    transferInquiry: jest.fn(async (i: { partnerReferenceNo: string }) => ({
      referenceNo: "INQ1", partnerReferenceNo: i.partnerReferenceNo, beneficiaryAccountName: "RIA", rawResponse: { referenceNo: "INQ1", beneficiaryAccountName: "RIA" },
    })),
    transferPayment: jest.fn(async () => ({ referenceNo: "TR1", rawResponse: {} })),
    debit: jest.fn(async () => ({ referenceNo: "DB1", latestTransactionStatus: "00", rawResponse: {} })),
    debitCancel: jest.fn(async () => ({ refundNo: "RF1", latestTransactionStatus: "00", rawResponse: {} })),
    topupVoid: jest.fn(async () => ({ latestTransactionStatus: "05", rawResponse: {} })),
    createSplitRule: jest.fn(async () => ({ splitRuleId: "SR1", rawResponse: {} })),
  } as unknown as jest.Mocked<SubAccountProvider>;
}

function checkoutStub() {
  return {
    createPayment: jest.fn(async (i: { invoiceNumber: string }) => ({
      paymentUrl: `https://sandbox.doku.com/checkout/${i.invoiceNumber}`,
      tokenId: "TOK1",
      expiredDate: "20240101000000",
      sessionId: "SES1",
      rawResponse: { message: ["SUCCESS"] },
    })),
  } as unknown as jest.Mocked<DokuCheckoutClient>;
}

function setup(store?: Record<string, string>) {
  // ponytail: any-typed mock — shapes vary per test, strictness adds nothing here.
  const prisma: any = {
    fiatProviderAccount: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      create: jest.fn(async (args: any) => ({ id: "a1", accountStatus: "creating", profileId: null, providerAccountId: null, vaNumber: null, phoneNo: null, email: null, accounts: null, lastBalance: null, lastBalanceAt: null, providerResponse: {}, updatedAt: new Date(), ...args.data })),
      update: jest.fn(async (args: any) => ({
        id: "a1", accountStatus: "creating", profileId: null, providerAccountId: null, vaNumber: null, phoneNo: null, email: null, accounts: null, lastBalance: null, lastBalanceAt: null, providerResponse: {}, updatedAt: new Date(), ...args.data,
      })),
    },
    fiatProviderTransaction: {
      create: jest.fn(async (args: any) => ({ id: "t1", providerStatus: "created", feeIdr: null, netIdr: null, createdAt: new Date(), ...args.data })),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(async (args: any) => ({ id: "t1", kind: "transfer_internal", providerRef: "ST1", amountIdr: 50000n, feeIdr: null, netIdr: null, createdAt: new Date(), ...args.data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      upsert: jest.fn(async (args: any) => ({ id: "t1", ...args.create })),
    },
    fiatWebhookEvent: {
      create: jest.fn(async (args: any) => ({ id: "e1", status: "received", ...args.data })),
      update: jest.fn(async (args: any) => ({ ...args.data })),
    },
    fiatFeePolicy: {
      findFirst: jest.fn(async () => ({ version: 3, percentBps: 500, minIdr: 0n, maxIdr: 0n, active: true })),
      findUnique: jest.fn(async () => null),
      aggregate: jest.fn(async () => ({ _max: { version: 1 } })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async (args: any) => ({ createdAt: new Date(), ...args.data })),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const sac = sacStub();
  const checkout = checkoutStub();
  const security = { log: jest.fn(async () => undefined) };
  const service = new FiatSubAccountService(prisma as never, configStub(store), sac, checkout, security as never);
  return { service, prisma, sac, checkout };
}

const ACTIVE = {
  id: "a1", accountStatus: "active", profileId: "PROF1", providerAccountId: "1140340010",
  pointAccountId: "2211403401",
  accounts: [
    { type: "DOKU_MERCHANT_IDR", currency: "IDR", accountNo: "1140340010" },
    { type: "DOKU_MERCHANT_PENDING_IDR", currency: "IDR", accountNo: "1140340011" },
    { type: "DOKU_MERCHANT_POINT", currency: "POINT", accountNo: "2211403401" },
  ],
  vaNumber: "888001140340010", phoneNo: null, email: "u@e.co",
  lastBalance: null, lastBalanceAt: null, providerResponse: {}, updatedAt: new Date(),
};

describe("FiatSubAccountService", () => {
  it("registerAccount is idempotent per pid (reuses profileId, no second DOKU call)", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValueOnce({ ...ACTIVE });
    const view = await service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" });
    expect(sac.register).not.toHaveBeenCalled();
    expect(view.profileId).toBe("PROF1");
    expect(view.status).toBe("active");
  });

  it("registerAccount inserts the creating row before calling DOKU (race-safe)", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValueOnce(null);
    const order: string[] = [];
    prisma.fiatProviderAccount.create.mockImplementationOnce(async (args: any) => {
      order.push("row");
      return { id: "a1", updatedAt: new Date(), ...args.data };
    });
    (sac.register as jest.Mock).mockImplementationOnce(async (args: any) => {
      order.push("doku");
      return { profileId: "P1", accounts: [], rawResponse: {} };
    });
    await service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" });
    expect(order).toEqual(["row", "doku"]);
  });

  it("registerAccount rejects a truly concurrent registration with 409", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue(null);
    let release!: (v: unknown) => void;
    const gate = new Promise((resolve) => { release = resolve as (v: unknown) => void; });
    (sac.register as jest.Mock).mockImplementationOnce(() => gate.then(() => ({ profileId: "P1", accounts: [], rawResponse: {} })));
    const first = service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" });
    await expect(service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" })).rejects.toMatchObject({ status: 409 });
    expect(sac.register).toHaveBeenCalledTimes(1);
    release(null);
    const view = await first;
    expect(view.status).toBe("active");
  });

  it("registerAccount marks a failed call failed and retries immediately (no 5-min trap)", async () => {
    const { service, prisma, sac } = setup();
    const { ProviderError } = await import("@peridotvault/pid-payments");
    prisma.fiatProviderAccount.findUnique.mockResolvedValue(null);
    (sac.register as jest.Mock)
      .mockRejectedValueOnce(new ProviderError(502, "boom"))
      .mockResolvedValueOnce({ profileId: "P1", accounts: [], rawResponse: {} });
    await expect(service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" })).rejects.toMatchObject({ status: 503 });
    expect(prisma.fiatProviderAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ accountStatus: "failed" }) }),
    );
    const view = await service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" });
    expect(sac.register).toHaveBeenCalledTimes(2);
    expect(view.status).toBe("active");
  });

  it("registerAccount maps Email Already Exists to an ops-actionable 409", async () => {
    const { service, prisma, sac } = setup();
    const { ProviderError } = await import("@peridotvault/pid-payments");
    prisma.fiatProviderAccount.findUnique.mockResolvedValue(null);
    (sac.register as jest.Mock).mockRejectedValueOnce(new ProviderError(400, "DOKU Sub-Account register (400): Email Already Exists"));
    await expect(service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("ops must link"),
    });
    expect(prisma.fiatProviderAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ accountStatus: "failed" }) }),
    );
  });

  it("registerAccount re-registers over a dead creating row without waiting", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValueOnce({
      ...ACTIVE, profileId: null, accountStatus: "creating", updatedAt: new Date(),
    });
    const view = await service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" });
    expect(sac.register).toHaveBeenCalled();
    expect(view.status).toBe("active");
  });

  it("registerAccount sends name + email only (V2 has no phone/OTP requirement)", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValueOnce(null);
    await service.registerAccount("ifal@pid", { name: "Ifal", email: "u@e.co" });
    expect(sac.register).toHaveBeenCalledWith(expect.not.objectContaining({ phoneNo: expect.anything() }));
    expect(sac.register).toHaveBeenCalledWith(expect.objectContaining({ name: "Ifal", email: "u@e.co" }));
  });

  it("fee = flat 5% of amount, half-up, no floor, no cap", () => {
    expect(calcServiceFee(7_000n)).toBe(350n);
    expect(calcServiceFee(30_000n)).toBe(1_500n);
    expect(calcServiceFee(99_999n)).toBe(5_000n); // 4999.95 → half-up 5000
    expect(calcServiceFee(100_000n)).toBe(5_000n);
    expect(calcServiceFee(200_000n)).toBe(10_000n);
    expect(calcServiceFee(500_000n)).toBe(25_000n);
    expect(calcServiceFee(1_000_000n)).toBe(50_000n); // no cap
    expect(calcServiceFee(10_000_000n)).toBe(500_000n);
  });

  it("parseIdrStrict rejects floats, exp-notation, commas, signs, fractions", () => {
    expect(parseIdrStrict("500000")).toBe(500000n);
    expect(parseIdrStrict("500000.00")).toBe(500000n);
    expect(parseIdrStrict(500000)).toBe(500000n);
    expect(() => parseIdrStrict("1e+21")).toThrow();
    expect(() => parseIdrStrict("500,000")).toThrow();
    expect(() => parseIdrStrict("-5")).toThrow();
    expect(() => parseIdrStrict("500000.50")).toThrow();
    expect(() => parseIdrStrict(500000.5)).toThrow();
    expect(() => parseIdrStrict(null)).toThrow();
  });

  it("balance returns spendable points plus fiat backing", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    (sac.balance as jest.Mock).mockResolvedValueOnce({
      profileId: "PROF1",
      accounts: [
        { type: "DOKU_MERCHANT_IDR", currency: "IDR", accountNo: "1140340010", available: "150000.00", reserved: "0.00" },
        { type: "DOKU_MERCHANT_PENDING_IDR", currency: "IDR", accountNo: "1140340011", available: "105000.00", reserved: "0.00" },
        { type: "DOKU_MERCHANT_POINT", currency: "POINT", accountNo: "2211403401", available: "100000.00", reserved: "0.00" },
      ],
      rawResponse: {},
    });
    const out = await service.balance("ifal@pid");
    expect(out.pointsAvailableIdr).toBe("100000");
    expect(out.availableIdr).toBe("150000");
    expect(out.pendingIdr).toBe("105000");
    expect(prisma.fiatProviderAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastPointBalance: "100000" }) }),
    );
  });

  it("balance maps persistent 429 to retryable 503 (not 400)", async () => {
    const { service, prisma } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    const { ProviderError } = await import("@peridotvault/pid-payments");
    (service as any).sac.balance.mockRejectedValue(new ProviderError(429, "rate limited"));
    await expect(service.balance("ifal@pid")).rejects.toMatchObject({ status: 503 });
    expect((service as any).sac.balance).toHaveBeenCalledTimes(3); // backoff retry, then give up
  }, 15000);

  it("transferInquiry resolves the recipient PID to POINT accounts and snapshots the quote", async () => {
    const { service, prisma } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    const view = await service.transferInquiry("ifal@pid", { type: "DOKU_SUB_ACCOUNT", amountIdr: "100000", beneficiaryPid: "rani@pid" });
    expect(view.grossIdr).toBe("100000");
    expect(view.feeIdr).toBe("5000");
    expect(view.netIdr).toBe("95000");
    expect(view.feePolicyVersion).toBe(3);
    expect(prisma.fiatProviderTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountIdr: 100000n, feeIdr: 5000n, netIdr: 95000n, feePolicyVersion: 3,
          accountId: "2211403401",
          counterparty: expect.objectContaining({ beneficiaryPid: "rani@pid", currency: "POINT" }),
        }),
      }),
    );
  });

  it("transferInquiry rejects self-transfer and unknown recipients", async () => {
    const { service, prisma } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    await expect(service.transferInquiry("ifal@pid", { type: "DOKU_SUB_ACCOUNT", amountIdr: "100000", beneficiaryPid: "ifal@pid" }))
      .rejects.toMatchObject({ status: 400 });
    prisma.fiatProviderAccount.findUnique.mockResolvedValue(null);
    await expect(service.transferInquiry("ghost@pid", { type: "DOKU_SUB_ACCOUNT", amountIdr: "100000", beneficiaryPid: "rani@pid" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("transferConfirm writes the recipient mirror keyed by the DOKU reference", async () => {
    const { service, prisma, sac } = setup({ DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999" });
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue({
      id: "t1", pid: "ifal@pid", kind: "transfer_internal", providerRef: "ST1", providerStatus: "created",
      amountIdr: 100000n, feeIdr: 5000n, netIdr: 95000n, createdAt: new Date(),
      counterparty: { type: "DOKU_SUB_ACCOUNT", beneficiaryPid: "rani@pid", beneficiaryAccountNumber: "2211403402", feePolicyVersion: 3 },
      providerResponse: { referenceNo: "INQ1", beneficiaryAccountName: "RIA" },
    });
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => ({ id: "f1", providerStatus: "created", createdAt: new Date(), ...args.data }));
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => ({
      id: "t1", kind: "transfer_internal", providerRef: "ST1", amountIdr: 100000n, feeIdr: 5000n, netIdr: 95000n, createdAt: new Date(), ...args.data,
    }));
    prisma.fiatFeePolicy.findUnique.mockResolvedValue({ version: 3, percentBps: 500, minIdr: 0n, maxIdr: 0n, active: true });
    (sac.transferPayment as jest.Mock).mockResolvedValue({ referenceNo: "DOKU-P2P-1", rawResponse: {} });
    (sac.txStatus as jest.Mock).mockResolvedValue({ partnerReferenceNo: "x", latestTransactionStatus: "00", rawResponse: {} });
    await service.transferConfirm("ifal@pid", "t1", { beneficiaryAccountName: "RIA", expectedName: "RIA" });
    expect(prisma.fiatProviderTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerRef: "DOKU-P2P-1" },
        create: expect.objectContaining({
          pid: "rani@pid", kind: "points_credit", amountIdr: 95000n,
          direction: "in", entryGroup: "ST1",
          counterparty: expect.objectContaining({ parentRef: "ST1" }),
        }),
      }),
    );
  });

  it("parallel confirms on the same row serialize and collapse to one mirror", async () => {
    const { service, prisma, sac } = setup({ DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999" });
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue({
      id: "t1", pid: "ifal@pid", kind: "transfer_internal", providerRef: "ST1", providerStatus: "created",
      amountIdr: 100000n, feeIdr: 5000n, netIdr: 95000n, createdAt: new Date(),
      counterparty: { type: "DOKU_SUB_ACCOUNT", beneficiaryPid: "rani@pid", beneficiaryAccountNumber: "2211403402", feePolicyVersion: 3 },
      providerResponse: { referenceNo: "INQ1", beneficiaryAccountName: "RIA" },
    });
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatFeePolicy.findUnique.mockResolvedValue({ version: 3, percentBps: 500, minIdr: 0n, maxIdr: 0n, active: true });
    (sac.transferPayment as jest.Mock).mockResolvedValue({ referenceNo: "DOKU-P2P-1", rawResponse: {} });
    (sac.txStatus as jest.Mock).mockResolvedValue({ partnerReferenceNo: "x", latestTransactionStatus: "00", rawResponse: {} });
    await Promise.all([
      service.transferConfirm("ifal@pid", "t1", { beneficiaryAccountName: "RIA" }),
      service.transferConfirm("ifal@pid", "t1", { beneficiaryAccountName: "RIA" }),
    ]);
    // Mirror upsert is idempotent on providerRef — both attempts converge
    // on the same ref (second finds the settled row and confirms it).
    const mirrorCalls = (prisma.fiatProviderTransaction.upsert as jest.Mock).mock.calls
      .filter((c) => c[0]?.where?.providerRef === "DOKU-P2P-1");
    expect(mirrorCalls.length).toBe(2);
    expect(mirrorCalls[0][0].create.entryGroup).toBe("ST1");
  });

  it("withPidLocks serializes same-pid sections and orders cross-pid locks", async () => {
    const { service } = setup();
    const order: string[] = [];
    const gate = (name: string, ms: number) => (service as any).withPidLocks(["ifal@pid"], async () => {
      order.push(`${name}-in`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${name}-out`);
    });
    await Promise.all([gate("a", 30), gate("b", 0)]);
    expect(order).toEqual(["a-in", "a-out", "b-in", "b-out"]);
  });

  it("transferConfirm sends NET points P2P plus the Treasury fee leg", async () => {
    const { service, prisma, sac } = setup({ DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999" });
    const createdRow = {
      id: "t1", pid: "ifal@pid", kind: "transfer_internal", providerRef: "ST1", providerStatus: "created",
      amountIdr: 100000n, feeIdr: 5000n, netIdr: 95000n, createdAt: new Date(),
      counterparty: { type: "DOKU_SUB_ACCOUNT", beneficiaryPid: "rani@pid", beneficiaryAccountNumber: "2211403402", feePolicyVersion: 3 },
      providerResponse: { referenceNo: "INQ1", beneficiaryAccountName: "RIA" },
    };
    let confirmReads = 0;
    (prisma.fiatProviderTransaction.findFirst as jest.Mock).mockImplementation(async (args: any) => {
      // Fee-leg existence checks find nothing (fresh world) — treasury leg runs.
      if (args?.where?.kind === "points_fee") return null;
      confirmReads++;
      return confirmReads <= 2 ? createdRow : { ...createdRow, providerStatus: "settled" };
    });
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => ({ id: "f1", providerStatus: "created", createdAt: new Date(), ...args.data }));
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => ({
      id: "t1", kind: "transfer_internal", providerRef: "ST1", amountIdr: 100000n, feeIdr: 5000n, netIdr: 95000n, createdAt: new Date(), ...args.data,
    }));
    prisma.fiatFeePolicy.findUnique.mockResolvedValue({ version: 3, percentBps: 500, minIdr: 0n, maxIdr: 0n, active: true });
    (sac.txStatus as jest.Mock).mockResolvedValue({ partnerReferenceNo: "ST1-PTFEE", latestTransactionStatus: "00", rawResponse: {} });
    const view = await service.transferConfirm("ifal@pid", "t1", { beneficiaryAccountName: "RIA", expectedName: "RIA" });
    // Recipient receives net points, not gross.
    expect(sac.transferPayment).toHaveBeenCalledWith(expect.objectContaining({
      partnerReferenceNo: "ST1", referenceNo: "INQ1", type: "DOKU_SUB_ACCOUNT",
      amountIdr: 95000n, currency: "POINT", fromAccount: "2211403401",
    }));
    // Treasury fee leg moves as POINT P2P under its own ref.
    expect(sac.transferPayment).toHaveBeenCalledWith(expect.objectContaining({
      partnerReferenceNo: "ST1-PTFEE", type: "DOKU_SUB_ACCOUNT",
      amountIdr: 5000n, currency: "POINT", beneficiaryAccountNumber: "2299999999",
    }));
    // P2P corroborated settled at confirm time (parent + mirror settle together).
    expect(view.providerStatus).toBe("settled");
  });

  // NOTE: settleFee / fee-leg tests were removed with the API-side fee
  // settlement. DOKU settles NET → user + FEE → Treasury natively.

  it("createCheckoutDeposit takes net, charges gross, returns the hosted URL", async () => {
    const { service, prisma, checkout } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    const order: string[] = [];
    prisma.fiatProviderTransaction.create.mockImplementationOnce(async (args: any) => {
      order.push("row");
      return { id: "t1", providerStatus: "created", createdAt: new Date(), ...args.data };
    });
    (checkout.createPayment as jest.Mock).mockImplementationOnce(async () => {
      order.push("doku");
      return { paymentUrl: "https://pay.example/1", tokenId: "T", rawResponse: {} };
    });
    prisma.fiatProviderTransaction.update.mockImplementationOnce(async (args: any) => ({
      id: "t1", kind: "deposit", providerRef: "DP1", amountIdr: 105000n, feeIdr: null, netIdr: null, createdAt: new Date(), ...args.data,
    }));
    // User types net 100000 → fee 5000 → charged gross 105000.
    const view = await service.createCheckoutDeposit("ifal@pid", "100000");
    expect(order).toEqual(["row", "doku"]);
    expect(checkout.createPayment).toHaveBeenCalledWith(expect.objectContaining({ grossAmountIdr: 105000n, profileId: "PROF1" }));
    // DOKU-rendered customer name is always the pid, never the display name.
    expect(checkout.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({ customer: expect.objectContaining({ id: "ifal@pid", name: "ifal@pid" }) }),
    );
    expect(view.grossIdr).toBe("105000");
    expect(view.feeIdr).toBe("5000");
    expect(view.netIdr).toBe("100000");
    expect(view.paymentUrl).toBe("https://pay.example/1");
  });

  it("createCheckoutDeposit rejects net below Rp100.000 with a clear minimum error", async () => {
    const { service, prisma, checkout } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    await expect(service.createCheckoutDeposit("ifal@pid", "99999")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Minimum top-up is Rp100.000"),
    });
    expect(checkout.createPayment).not.toHaveBeenCalled();
    expect(prisma.fiatProviderTransaction.create).not.toHaveBeenCalled();
  });

  it("createCheckoutDeposit applies flat 5% with no cap (net 1M → gross 1.05M)", async () => {
    const { service, prisma, checkout } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.create.mockImplementationOnce(async (args: any) => ({
      id: "t1", providerStatus: "created", createdAt: new Date(), ...args.data,
    }));
    (checkout.createPayment as jest.Mock).mockImplementationOnce(async () => ({
      paymentUrl: "https://pay.example/2", tokenId: "T", rawResponse: {},
    }));
    prisma.fiatProviderTransaction.update.mockImplementationOnce(async (args: any) => ({
      id: "t1", kind: "deposit", providerRef: "DP2", amountIdr: 1050000n, feeIdr: null, netIdr: null, createdAt: new Date(), ...args.data,
    }));
    const view = await service.createCheckoutDeposit("ifal@pid", "1000000");
    expect(checkout.createPayment).toHaveBeenCalledWith(expect.objectContaining({ grossAmountIdr: 1050000n, profileId: "PROF1" }));
    expect(view.grossIdr).toBe("1050000");
    expect(view.feeIdr).toBe("50000");
    expect(view.netIdr).toBe("1000000");
  });

  it("createCheckoutDeposit opens ledger+settlement as pending (issuance happens on paid)", async () => {
    const { service, prisma, checkout } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.create.mockImplementationOnce(async (args: any) => ({
      id: "t1", providerStatus: "created", createdAt: new Date(), ...args.data,
    }));
    (checkout.createPayment as jest.Mock).mockImplementationOnce(async () => ({
      paymentUrl: "https://pay.example/3", tokenId: "T", rawResponse: {},
    }));
    prisma.fiatProviderTransaction.update.mockImplementationOnce(async (args: any) => ({
      id: "t1", kind: "deposit", providerRef: "DP3", amountIdr: 105000n, createdAt: new Date(), ...args.data,
    }));
    await service.createCheckoutDeposit("ifal@pid", "100000");
    expect(prisma.fiatProviderTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ledgerStatus: "pending", settlementStatus: "pending" }),
      }),
    );
  });

  it("createCheckoutDeposit sends no fiat split rule (fee moves as Treasury points)", async () => {
    const { service, prisma, checkout } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.create.mockImplementationOnce(async (args: any) => ({
      id: "t1", providerStatus: "created", createdAt: new Date(), ...args.data,
    }));
    (checkout.createPayment as jest.Mock).mockImplementationOnce(async () => ({
      paymentUrl: "https://pay.example/4", tokenId: "T", rawResponse: {},
    }));
    prisma.fiatProviderTransaction.update.mockImplementationOnce(async (args: any) => ({
      id: "t1", kind: "deposit", providerRef: "DP4", amountIdr: 105000n, createdAt: new Date(), ...args.data,
    }));
    await service.createCheckoutDeposit("ifal@pid", "100000");
    const args = (checkout.createPayment as jest.Mock).mock.calls[0][0];
    expect(args.splitRuleId).toBeUndefined();
  });

  it("webhook dedups replays and keeps unparseable amounts received", async () => {
    const { service, prisma } = setup();
    await expect(service.webhook(undefined, "{}")).resolves.toEqual({ ok: false });
    prisma.fiatWebhookEvent.create.mockRejectedValueOnce(new Error("unique"));
    await expect(service.webhook("ext-1", "{}")).resolves.toEqual({ ok: true });
    expect(prisma.fiatProviderTransaction.findUnique).not.toHaveBeenCalled();
    // Unknown ref + garbage amount → recorded nothing, stays received.
    prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(null);
    await expect(service.webhook("ext-2", JSON.stringify({ partnerReferenceNo: "X1", toAccount: "1140340010", amount: "1e+21" }))).resolves.toEqual({ ok: true });
    expect(prisma.fiatProviderTransaction.upsert).not.toHaveBeenCalled();
    expect(prisma.fiatWebhookEvent.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalId: "ext-2" } }),
    );
  });

  it("webhook records BRI VA deposits against the static VA number", async () => {
    const { service, prisma } = setup();
    prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(null);
    prisma.fiatProviderAccount.findFirst.mockResolvedValueOnce(null);
    prisma.fiatProviderAccount.findMany.mockResolvedValueOnce([{ ...ACTIVE }]);
    await expect(
      service.webhook("ext-3", JSON.stringify({ partnerReferenceNo: "VA1", toAccount: "888001140340010", amount: { value: "50000.00", currency: "IDR" } })),
    ).resolves.toEqual({ ok: true });
    expect(prisma.fiatProviderTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerRef: "VA1" } }),
    );
    expect(prisma.fiatWebhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ where: { externalId: "ext-3" } }));
  });

  it("webhook flags VA credits below the Rp100.000 net minimum (funds preserved)", async () => {
    const { service, prisma } = setup();
    prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(null);
    prisma.fiatProviderAccount.findFirst.mockResolvedValueOnce(null);
    prisma.fiatProviderAccount.findMany.mockResolvedValueOnce([{ ...ACTIVE }]);
    // Gross 50.000 → fee 2.500 → net 47.500 < 100.000: kept, flagged.
    await expect(
      service.webhook("ext-4", JSON.stringify({ partnerReferenceNo: "VA2", toAccount: "888001140340010", amount: { value: "50000.00", currency: "IDR" } })),
    ).resolves.toEqual({ ok: true });
    expect(prisma.fiatProviderTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerRef: "VA2" },
        create: expect.objectContaining({ counterparty: expect.objectContaining({ belowMinimumNet: true }) }),
      }),
    );
    // Gross 200.000 → fee 10.000 → net 190.000 ≥ 100.000: kept, unflagged.
    prisma.fiatProviderTransaction.findUnique.mockResolvedValueOnce(null);
    prisma.fiatProviderAccount.findFirst.mockResolvedValueOnce(null);
    prisma.fiatProviderAccount.findMany.mockResolvedValueOnce([{ ...ACTIVE }]);
    await expect(
      service.webhook("ext-5", JSON.stringify({ partnerReferenceNo: "VA3", toAccount: "888001140340010", amount: { value: "200000.00", currency: "IDR" } })),
    ).resolves.toEqual({ ok: true });
    expect(prisma.fiatProviderTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerRef: "VA3" } }),
    );
    const lastUpsert = (prisma.fiatProviderTransaction.upsert as jest.Mock).mock.calls.at(-1)[0];
    expect(lastUpsert.create.counterparty ?? {}).not.toMatchObject({ belowMinimumNet: true });
  });

  it("reconcile backfills missed CREDIT+SUCCESS rows and reports gaps", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.findMany.mockResolvedValue([]);
    (sac.history as jest.Mock)
      .mockResolvedValueOnce({
        items: [{ mutationType: "CREDIT", status: "SUCCESS", amount: 75000, amountIdr: "75000", partnerReferenceNo: "MISSED1", transactionType: "PAYMENT", channel: "VIRTUAL_ACCOUNT_BCA" }],
        rawResponse: {},
      })
      .mockResolvedValue({ items: [], rawResponse: {} });
    (sac.balance as jest.Mock).mockResolvedValueOnce({ accounts: [], rawResponse: {} });
    const out = await service.reconcile("ifal@pid", { fromDateTime: "2026-01-01", toDateTime: "2026-02-01" });
    expect(out.backfilled).toBe(1);
    expect(prisma.fiatProviderTransaction.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { providerRef: "MISSED1" } }));
    expect(out.missingProvider).toEqual([]);
    expect(out.pendingIssuance).toEqual([]);
  });

  it("reconcile reports pending issuance for paid deposits missing points", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.findMany.mockResolvedValue([
      {
        id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP-PENDING", providerStatus: "settled",
        amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
        ledgerStatus: "pending", settlementStatus: "pending",
        counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000" },
      },
      {
        id: "d2", pid: "ifal@pid", kind: "deposit", providerRef: "DP-DONE", providerStatus: "settled",
        amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
        ledgerStatus: "issued", ledgerRef: "DP-DONE-PTS", settlementStatus: "settled",
        counterparty: { channel: "checkout" },
      },
    ]);
    (sac.history as jest.Mock).mockResolvedValue({ items: [], rawResponse: {} });
    (sac.balance as jest.Mock).mockResolvedValue({ accounts: [], rawResponse: {} });
    // Issuance attempted for DP-PENDING but SYSTEM_POINT is unconfigured in
    // this setup — it stays pending and is reported, never half-issued.
    const out = await service.reconcile("ifal@pid", { fromDateTime: "2026-01-01", toDateTime: "2026-02-01" });
    expect(out.pendingIssuance).toEqual(["DP-PENDING"]);
    expect(out.backing).toMatchObject({ livePointsIdr: "0" });
  });

  it("fail-safe: SYSTEM_POINT unconfigured → no journal row, no DOKU call, parent stays pending", async () => {
    const { service, prisma, sac } = setup(); // no DOKU_SYSTEM_POINT_ACCOUNT_NO
    const settled = {
      id: "d1", pid: "alice@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
      ledgerStatus: "pending", settlementStatus: "pending",
      counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
      providerResponse: {},
    };
    prisma.fiatProviderTransaction.findUnique.mockResolvedValue(settled);
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    (sac.txStatus as jest.Mock).mockResolvedValue({
      partnerReferenceNo: "DP1", latestTransactionStatus: "00", rawResponse: {},
    });
    await (service as any).issuePointsForDeposit("d1", "fail-safe");
    // systemPointAccount() throws while building the leg-row args — before
    // any journal write and before any DOKU call. Nothing spendable created.
    expect(prisma.fiatProviderTransaction.create).not.toHaveBeenCalled();
    expect(sac.transferInquiry).not.toHaveBeenCalled();
    expect(sac.transferPayment).not.toHaveBeenCalled();
    expect(prisma.fiatProviderTransaction.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1" } }),
    );
  });

  it("fail-safe: 4004203 at inquiry → failed leg, retryable parent, no payment call", async () => {
    const { service, prisma, sac } = setup({ DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001" });
    const { ProviderError } = await import("@peridotvault/pid-payments");
    const settled = {
      id: "d1", pid: "alice@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
      ledgerStatus: "pending", settlementStatus: "pending",
      counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
      providerResponse: {},
    };
    prisma.fiatProviderTransaction.findUnique.mockResolvedValue(settled);
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => ({ id: "leg1", providerStatus: "created", createdAt: new Date(), ...args.data }));
    (sac.txStatus as jest.Mock).mockResolvedValue({
      partnerReferenceNo: "DP1", latestTransactionStatus: "00", rawResponse: {},
    });
    (sac.transferInquiry as jest.Mock).mockRejectedValue(
      new ProviderError(400, "DOKU Sub-Account transfer-inquiry (4004203): Source account not configured for TOPUP"),
    );
    await (service as any).issuePointsForDeposit("d1", "fail-safe");
    // Leg row recorded as failed (auditable), parent left failed/retryable,
    // and crucially no transferPayment was ever attempted.
    expect(sac.transferPayment).not.toHaveBeenCalled();
    expect(prisma.fiatProviderTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1" }, data: expect.objectContaining({ ledgerStatus: "failed" }) }),
    );
  });

  it("backing gap is info-only per PID — only replay mismatch alerts", async () => {    const { service, prisma, sac } = setup();
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    // Journal says Alice owns 60k; DOKU holds 60k; fiat backing is 105k
    // (over-backed after P2P) — no alert. Replay mismatch WOULD alert.
    prisma.fiatProviderTransaction.findMany.mockResolvedValue([
      { kind: "points_issue", pid: "ifal@pid", providerRef: "DP1-PTS", providerStatus: "settled", amountIdr: 100000n, direction: "in", entryGroup: "DP1", extinguished: false, counterparty: null, replaySeq: 1n },
      { kind: "points_fee", pid: "ifal@pid", providerRef: "DP1-PTS-FEE", providerStatus: "settled", amountIdr: 5000n, direction: "out", entryGroup: "DP1", extinguished: false, counterparty: { destination: "treasury" }, replaySeq: 2n },
      { kind: "transfer_internal", pid: "ifal@pid", providerRef: "ST1", providerStatus: "settled", amountIdr: 40000n, direction: "out", entryGroup: "ST1", extinguished: false, counterparty: { currency: "POINT" }, replaySeq: 3n },
      { kind: "points_credit", pid: "rani@pid", providerRef: "DOKU-R1", providerStatus: "settled", amountIdr: 38000n, direction: "in", entryGroup: "ST1", extinguished: false, counterparty: { parentRef: "ST1" }, replaySeq: 4n },
      { kind: "points_fee", pid: "ifal@pid", providerRef: "ST1-PTFEE", providerStatus: "settled", amountIdr: 2000n, direction: "out", entryGroup: "ST1", extinguished: false, counterparty: { destination: "treasury" }, replaySeq: 5n },
    ]);
    (sac.balance as jest.Mock).mockResolvedValue({
      profileId: "PROF1",
      accounts: [
        { type: "DOKU_MERCHANT_IDR", currency: "IDR", accountNo: "1140340010", available: "105000.00", reserved: "0.00" },
        { type: "DOKU_MERCHANT_PENDING_IDR", currency: "IDR", accountNo: "1140340011", available: "0.00", reserved: "0.00" },
        { type: "DOKU_MERCHANT_POINT", currency: "POINT", accountNo: "2211403401", available: "60000.00", reserved: "0.00" },
      ],
      rawResponse: {},
    });
    const out = await service.reconcile("ifal@pid", { fromDateTime: "2026-01-01", toDateTime: "2026-02-01" });
    expect(out.backing!.alerts).toEqual([]);
    expect(out.backing!.livePointsIdr).toBe("60000");
    expect(out.backing!.replayedIdr).toBe("60000");
    // Now break invariant 1: DOKU holds 59k — must alert.
    (sac.balance as jest.Mock).mockResolvedValue({
      profileId: "PROF1",
      accounts: [
        { type: "DOKU_MERCHANT_IDR", currency: "IDR", accountNo: "1140340010", available: "105000.00", reserved: "0.00" },
        { type: "DOKU_MERCHANT_PENDING_IDR", currency: "IDR", accountNo: "1140340011", available: "0.00", reserved: "0.00" },
        { type: "DOKU_MERCHANT_POINT", currency: "POINT", accountNo: "2211403401", available: "59000.00", reserved: "0.00" },
      ],
      rawResponse: {},
    });
    const out2 = await service.reconcile("ifal@pid", { fromDateTime: "2026-01-01", toDateTime: "2026-02-01" });
    expect(out2.backing!.alerts.some((a: string) => a.includes("INVARIANT-1"))).toBe(true);
  });

  it("adminBackfillMirrors reconstructs from txStatus, queues the rest for review", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderTransaction.findMany.mockResolvedValue([
      {
        id: "t1", pid: "ifal@pid", kind: "transfer_internal", providerRef: "ST-OLD", providerStatus: "settled",
        amountIdr: 40000n, createdAt: new Date(),
        counterparty: { beneficiaryPid: "rani@pid", beneficiaryAccountNumber: "2211403402", netQuote: "38000" },
        providerResponse: { referenceNo: "INQ-OLD" },
      },
      {
        id: "t2", pid: "ifal@pid", kind: "transfer_internal", providerRef: "ST-GONE", providerStatus: "settled",
        amountIdr: 40000n, createdAt: new Date(),
        counterparty: { beneficiaryPid: "rani@pid", beneficiaryAccountNumber: "2211403402", netQuote: "38000" },
        providerResponse: { referenceNo: "INQ-GONE" },
      },
    ]);
    const { ProviderError } = await import("@peridotvault/pid-payments");
    (sac.txStatus as jest.Mock).mockImplementation(async (ref: string) => {
      if (ref === "ST-OLD") return { partnerReferenceNo: ref, latestTransactionStatus: "00", rawResponse: { referenceNo: "DOKU-OLD" } };
      throw new ProviderError(404, "not found");
    });
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    const out = await service.adminBackfillMirrors({ take: 10 });
    expect(out.mirrored).toEqual(["ST-OLD"]);
    expect(out.manualReview).toEqual(["ST-GONE"]);
    expect(prisma.fiatProviderTransaction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { providerRef: "DOKU-OLD" },
        create: expect.objectContaining({
          pid: "rani@pid", kind: "points_credit", amountIdr: 38000n,
          counterparty: expect.objectContaining({ source: "mirror-backfill" }),
        }),
      }),
    );
  });

  it("E2E A→B→C→D: journal replays exact ownership; settlement creates nothing", async () => {
    const { service, prisma, sac } = setup({
      DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001",
      DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999",
    });
    const { replayJournal, totalOutstanding } = await import("./ledger-replay");
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderAccount.findFirst.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderAccount.findMany.mockResolvedValue([{ ...ACTIVE }]);
    const created: any[] = [];
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => {
      const id = `r${created.length + 1}`;
      created.push({ __id: id, ...args.data });
      return { id, providerStatus: "created", createdAt: new Date(), ...args.data };
    });
    // Mirrors are written via upsert — capture those creates too.
    prisma.fiatProviderTransaction.upsert.mockImplementation(async (args: any) => {
      if (args?.create?.kind === "points_credit") created.push(args.create);
      return { id: "t1", ...args.create };
    });
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => ({
      id: "x", kind: "deposit", providerRef: "DP", amountIdr: 0n, createdAt: new Date(), ...args.data,
    }));
    const settledDeposit = {
      id: "d1", pid: "alice@pid", kind: "deposit", providerRef: "DP-ALICE", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
      ledgerStatus: "pending", settlementStatus: "pending",
      counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
      providerResponse: {},
    };
    prisma.fiatProviderTransaction.findUnique.mockImplementation(async (args: any) => {
      const hit = created.find((c) => c.providerRef === args?.where?.providerRef);
      if (hit) return { id: "x", ...hit, providerStatus: "settled" };
      if (args?.where?.id) {
        const byId = created.find((c) => c.__id === args.where.id);
        if (byId) return { id: args.where.id, ...byId };
        return { ...settledDeposit };
      }
      return null;
    });
    prisma.fiatProviderTransaction.findFirst.mockImplementation(async (args: any) => {
      // Leg-existence checks find nothing (fresh world); transfer rows by id.
      if (args?.where?.kind === "points_issue" || args?.where?.kind === "points_fee" || args?.where?.kind === "points_credit") return null;
      const w = args?.where ?? {};
      if (w.id && w.pid) {
        const t = (service as any).__testHop ?? { ref: "ST-X", to: "bob@pid", gross: 40000n, fee: 2000n, net: 38000n };
        return {
          id: w.id, pid: w.pid, kind: "transfer_internal", providerRef: t.ref,
          providerStatus: "created", amountIdr: t.gross, feeIdr: t.fee, netIdr: t.net, createdAt: new Date(),
          counterparty: { type: "DOKU_SUB_ACCOUNT", beneficiaryPid: t.to, beneficiaryAccountNumber: "2211403402", feePolicyVersion: 3, netQuote: String(t.net), feeQuote: String(t.fee) },
          providerResponse: { referenceNo: "INQ-X", beneficiaryAccountName: "X" },
        };
      }
      return null;
    });
    (sac.txStatus as jest.Mock).mockResolvedValue({
      partnerReferenceNo: "x", latestTransactionStatus: "00",
      amount: { value: "105000.00", currency: "IDR" }, rawResponse: {},
    });

    // 1. Alice's deposit issuance (checkout page tested elsewhere).
    await (service as any).issuePointsForDeposit("d1", "e2e");

    async function hop(from: string, to: string, gross: string, dokuRef: string) {
      const g = BigInt(gross);
      const fee = (g * 500n + 5_000n) / 10_000n;
      const inq = await service.transferInquiry(from, { type: "DOKU_SUB_ACCOUNT", amountIdr: gross, beneficiaryPid: to });
      (service as any).__testHop = { ref: inq.providerRef, to, gross: g, fee, net: g - fee };
      (sac.transferPayment as jest.Mock).mockResolvedValueOnce({ referenceNo: dokuRef, rawResponse: {} });
      await service.transferConfirm(from, inq.id, { beneficiaryAccountName: to });
    }
    // 2. Chain: Alice→Bob 40k, Bob→Charlie 20k, Charlie→David 19k.
    await hop("alice@pid", "bob@pid", "40000", "DOKU-R1");
    await hop("bob@pid", "charlie@pid", "20000", "DOKU-R2");
    await hop("charlie@pid", "david@pid", "19000", "DOKU-R3");

    // 3. Replay everything as settled (legs corroborated) → exact ownership.
    const journal = created.map((c, i) => ({
      kind: c.kind, pid: c.pid, providerRef: c.providerRef, providerStatus: "settled",
      amountIdr: c.amountIdr, direction: c.direction ?? null, entryGroup: c.entryGroup ?? null,
      extinguished: false, counterparty: c.counterparty ?? null, replaySeq: BigInt(i + 1),
    }));
    const r = replayJournal(journal);
    expect(r.errors).toEqual([]);
    expect(r.balances.get("alice@pid")).toBe(60_000n);
    expect(r.balances.get("bob@pid")).toBe(18_000n);
    expect(r.balances.get("charlie@pid")).toBe(0n);
    expect(r.balances.get("david@pid")).toBe(18_050n);
    expect(r.treasury).toBe(8_950n);
    expect(totalOutstanding(r)).toBe(105_000n);

    // 4. Fiat settlement later creates ZERO new legs (backing event only).
    // The journal already knows DP-ALICE as issued — history legs only flip
    // settlementStatus.
    prisma.fiatProviderTransaction.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.pid === "alice@pid" && !args?.where?.kind) {
        return [{
          id: "d1", pid: "alice@pid", kind: "deposit", providerRef: "DP-ALICE", providerStatus: "settled",
          amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
          ledgerStatus: "issued", ledgerRef: "DP-ALICE-PTS", settlementStatus: "pending",
          counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000" },
        }];
      }
      return [];
    });
    (sac.history as jest.Mock)
      .mockResolvedValueOnce({
        items: [
          { mutationType: "CREDIT", transactionType: "SETTLEMENT", amount: 100000, amountIdr: "100000", currency: "IDR", status: "SUCCESS", partnerReferenceNo: "DP-ALICE", referenceNo: "DOKU-S", channel: "VIRTUAL_ACCOUNT_BRI" },
          { mutationType: "CREDIT", transactionType: "SETTLEMENT_FEE", amount: 3000, amountIdr: "3000", currency: "IDR", status: "SUCCESS", partnerReferenceNo: "DP-ALICE", referenceNo: "DOKU-SF", channel: "VIRTUAL_ACCOUNT_BRI" },
        ],
        rawResponse: {},
      })
      .mockResolvedValue({ items: [], rawResponse: {} });
    const pointsCreatesBefore = created.filter((c) => String(c.kind).startsWith("points_")).length;
    const rec = await service.reconcile("alice@pid", { fromDateTime: "2026-01-01", toDateTime: "2026-02-01" });
    const pointsCreatesAfter = created.filter((c) => String(c.kind).startsWith("points_")).length;
    expect(pointsCreatesAfter).toBe(pointsCreatesBefore);
    expect(rec.pgObservedIdr).toBe("3000");
    // Settlement flipped backing state without creating value.
    expect(prisma.fiatProviderTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ settlementStatus: "settled" }) }),
    );
  });

  it("redemption is forbidden while the feature flag is off (no DOKU calls)", async () => {
    const { service, sac } = setup();
    await expect(service.requestRedemption("ifal@pid", {
      amountIdr: "50000", bankCode: "014", bankAccountNumber: "123", bankAccountName: "X",
    })).rejects.toMatchObject({ status: 403 });
    expect(sac.debit).not.toHaveBeenCalled();
    expect(sac.transferPayment).not.toHaveBeenCalled();
  });

  it("lifecycle: deposit→chain→settle→David redeems→consolidate→payout, invariants hold", async () => {
    const { service, prisma, sac } = setup({
      DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001",
      DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999",
      DOKU_TREASURY_ACCOUNT_NO: "2010000001",
      PID_REDEMPTION_ENABLED: "true",
    });
    const { replayJournal, totalOutstanding } = await import("./ledger-replay");
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderAccount.findFirst.mockResolvedValue({ lastBalance: "1000000" });
    const created: any[] = [];
    const updatesById: Record<string, any> = {};
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => {
      const id = `r${created.length + 1}`;
      created.push({ __id: id, ...args.data });
      return { id, providerStatus: "created", createdAt: new Date(), ...args.data };
    });
    prisma.fiatProviderTransaction.upsert.mockImplementation(async (args: any) => {
      if (args?.create?.kind === "points_credit") created.push(args.create);
      return { id: "t1", ...args.create };
    });
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => {
      if (args?.where?.id) {
        updatesById[args.where.id] = { ...(updatesById[args.where.id] ?? {}), ...args.data };
        // Write-through so id re-reads observe updated state (like real DB).
        const target = created.find((c: any) => c.__id === args.where.id);
        if (target) Object.assign(target, args.data);
      }
      return { id: "x", kind: "deposit", providerRef: "DP", amountIdr: 0n, createdAt: new Date(), ...args.data };
    });
    const settledDeposit = {
      id: "d1", pid: "alice@pid", kind: "deposit", providerRef: "DP-ALICE", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
      ledgerStatus: "pending", settlementStatus: "pending",
      counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
      providerResponse: {},
    };
    prisma.fiatProviderTransaction.findUnique.mockImplementation(async (args: any) => {
      const hit = created.find((c) => c.providerRef === args?.where?.providerRef);
      if (hit) return { id: "x", ...hit, providerStatus: "settled" };
      if (args?.where?.id) {
        const byId = created.find((c) => c.__id === args.where.id);
        if (byId) return { id: args.where.id, ...byId };
        return { ...settledDeposit };
      }
      return null;
    });
    (sac.txStatus as jest.Mock).mockResolvedValue({
      partnerReferenceNo: "x", latestTransactionStatus: "00",
      amount: { value: "105000.00", currency: "IDR" }, rawResponse: {},
    });
    const replayOf = () => replayJournal(created.map((c, i) => {
      const later = updatesById[`r${i + 1}`] ?? {};
      const merged = { ...c, ...later } as any;
      return {
        kind: merged.kind, pid: merged.pid, providerRef: merged.providerRef,
        providerStatus: later.providerStatus ?? "settled",
        amountIdr: merged.amountIdr, direction: merged.direction ?? null, entryGroup: merged.entryGroup ?? null,
        extinguished: merged.extinguished ?? false, counterparty: merged.counterparty ?? null, replaySeq: BigInt(i + 1),
      };
    }));

    // Stage 1: issuance.
    await (service as any).issuePointsForDeposit("d1", "e2e");
    let r = replayOf();
    expect(r.errors).toEqual([]);
    expect(r.balances.get("alice@pid")).toBe(100_000n);
    expect(totalOutstanding(r)).toBe(105_000n);

    // Stage 2: Alice→Bob 40k while fiat still pending (no settlement yet).
    prisma.fiatProviderTransaction.findFirst.mockImplementation(async (args: any) => {
      // Leg-existence checks resolve against already-written legs (idempotent).
      if (args?.where?.kind === "points_issue" || args?.where?.kind === "points_fee" || args?.where?.kind === "points_credit") {
        const hit = created.find((c) => c.kind === args.where.kind && c.providerRef === args.where.providerRef);
        return hit ? { ...hit, providerStatus: "settled" } : null;
      }
      // Echo the queried id so status updates land on the real created row.
      const w = args?.where ?? {};
      if (!w.id || !w.pid) return null;
      return {
        id: w.id, pid: w.pid, kind: "transfer_internal", providerRef: "ST-A",
        providerStatus: "created", amountIdr: 40000n, feeIdr: 2000n, netIdr: 38000n, createdAt: new Date(),
        counterparty: { type: "DOKU_SUB_ACCOUNT", beneficiaryPid: "bob@pid", beneficiaryAccountNumber: "2211403402", feePolicyVersion: 3, netQuote: "38000", feeQuote: "2000" },
        providerResponse: { referenceNo: "INQ-A", beneficiaryAccountName: "B" },
      };
    });
    (sac.transferPayment as jest.Mock).mockResolvedValue({ referenceNo: "DOKU-A", rawResponse: {} });
    const inq = await service.transferInquiry("alice@pid", { type: "DOKU_SUB_ACCOUNT", amountIdr: "40000", beneficiaryPid: "bob@pid" });
    await service.transferConfirm("alice@pid", inq.id, { beneficiaryAccountName: "bob@pid" });
    r = replayOf();
    expect(r.errors).toEqual([]);
    expect(r.balances.get("alice@pid")).toBe(60_000n);
    expect(r.balances.get("bob@pid")).toBe(38_000n);

    // Stage 3: duplicate issuance attempt changes nothing (idempotent).
    const legsBefore = created.filter((c) => String(c.kind).startsWith("points_")).length;
    await (service as any).issuePointsForDeposit("d1", "e2e-dup");
    expect(created.filter((c) => String(c.kind).startsWith("points_")).length).toBe(legsBefore);

    // Stage 4: Bob redeems 38k to a bank account (his fiat is 0 — pool covers).
    // replayedBalance reads the journal via findMany — serve written rows.
    (prisma.fiatProviderTransaction.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.pid) return created.filter((c: any) => c.pid === args.where.pid);
      return [];
    });
    (sac.debit as jest.Mock).mockResolvedValue({ referenceNo: "DB-RD", latestTransactionStatus: "00", rawResponse: {} });
    const redeemView = await service.requestRedemption("bob@pid", {
      amountIdr: "38000", bankCode: "014", bankAccountNumber: "8880001", bankAccountName: "Bob",
    });
    expect(redeemView.providerStatus).toBe("settled");
    r = replayOf();
    expect(r.errors).toEqual([]);
    expect(r.balances.get("bob@pid") ?? 0n).toBe(0n); // burned exactly once
    expect(totalOutstanding(r)).toBe(105_000n - 38_000n);
    // Payout went from the pool with the deterministic ref, once.
    expect(sac.transferPayment).toHaveBeenCalledWith(expect.objectContaining({
      type: "BANK_ACCOUNT", amountIdr: 38000n, beneficiaryAccountNumber: "8880001",
    }));
    const payoutCalls = (sac.transferPayment as jest.Mock).mock.calls.filter((c) => c[0]?.type === "BANK_ACCOUNT");
    expect(payoutCalls.length).toBe(1);
    expect(payoutCalls[0][0].partnerReferenceNo).toMatch(/-PAY$/);
  });

  it("concurrent duplicate issuance collapses to a single DOKU top-up", async () => {
    const { service, prisma, sac } = setup({
      DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001",
      DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999",
    });
    const settled = {
      id: "d1", pid: "alice@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
      ledgerStatus: "pending", settlementStatus: "pending",
      counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
      providerResponse: {},
    };
    const legs: any[] = [];
    // Ledger-aware mocks: re-reads observe completed issuance (like real DB).
    prisma.fiatProviderTransaction.findUnique.mockImplementation(async (args: any) => {
      if (!args?.where?.id) return null;
      const done = legs.some((l) => l.providerRef === "DP1-PTS" && l.__settled);
      return { ...settled, ledgerStatus: done ? "issued" : "pending" };
    });
    (prisma.fiatProviderTransaction.findFirst as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.kind === "points_issue" || args?.where?.kind === "points_fee") {
        return legs.find((l) => l.kind === args.where.kind && l.providerRef === args.where.providerRef) ?? null;
      }
      return null;
    });
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => {
      const row = { ...args.data };
      legs.push(row);
      return { id: `leg${legs.length}`, providerStatus: "created", createdAt: new Date(), ...args.data };
    });
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => {
      // Write-through: settled legs stay settled for the racing caller.
      if (args?.data?.providerStatus === "settled") {
        legs.forEach((l) => { l.__settled = true; });
      }
      return { id: "x", ...args.data };
    });
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    (sac.txStatus as jest.Mock).mockResolvedValue({
      partnerReferenceNo: "x", latestTransactionStatus: "00",
      amount: { value: "105000.00", currency: "IDR" }, rawResponse: {},
    });
    await Promise.all([
      (service as any).issuePointsForDeposit("d1", "race-a"),
      (service as any).issuePointsForDeposit("d1", "race-b"),
    ]);
    const userLegs = (sac.transferPayment as jest.Mock).mock.calls.filter((c) => c[0]?.partnerReferenceNo === "DP1-PTS");
    expect(userLegs.length).toBe(1);
  });

  it("failed payout resumes under the same ref via sweep (no re-burn)", async () => {
    const { service, prisma, sac } = setup({
      DOKU_TREASURY_ACCOUNT_NO: "2010000001",
      PID_REDEMPTION_ENABLED: "true",
    });
    const { ProviderError } = await import("@peridotvault/pid-payments");
    const burnedParent = {
      id: "rd1", pid: "bob@pid", kind: "redemption", providerRef: "RD-1", providerStatus: "processing",
      amountIdr: 38000n, feeIdr: null, netIdr: 38000n, createdAt: new Date(),
      ledgerStatus: "burned",
      counterparty: { bankCode: "014", bankAccountNumber: "8880001", bankAccountName: "Bob", channel: "BI_FAST" },
      providerResponse: {},
    };
    prisma.fiatProviderAccount.count.mockResolvedValue(1);
    prisma.fiatProviderAccount.findMany.mockResolvedValue([{ pid: "bob@pid" }]);
    prisma.fiatProviderAccount.findFirst.mockResolvedValue({ lastBalance: "1000000" });
    (prisma.fiatProviderTransaction.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.kind === "redemption") return [burnedParent];
      return [];
    });
    prisma.fiatProviderTransaction.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.id === "rd1") return { ...burnedParent };
      return null;
    });
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue(null);
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => ({ id: "pay1", providerStatus: "created", createdAt: new Date(), ...args.data }));
    (sac.transferInquiry as jest.Mock).mockResolvedValue({ referenceNo: "INQ-PAY", beneficiaryAccountName: "Bob", rawResponse: {} });
    // Persistent gateway failure on sweep 1 (withRetry exhausts), success on sweep 2.
    (sac.transferPayment as jest.Mock).mockRejectedValue(new ProviderError(502, "gateway down"));
    (sac.txStatus as jest.Mock).mockResolvedValue({ partnerReferenceNo: "x", latestTransactionStatus: "00", rawResponse: {} });
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    const first = await service.adminSweep({ take: 5 });
    expect(first.recovery).toMatchObject({ resumed: 0 });
    (sac.transferPayment as jest.Mock).mockResolvedValue({ referenceNo: "BK-1", rawResponse: {} });
    const second = await service.adminSweep({ take: 5 });
    expect(second.recovery).toMatchObject({ resumed: 1 });
    const pays = (sac.transferPayment as jest.Mock).mock.calls.filter((c) => c[0]?.type === "BANK_ACCOUNT");
    expect(pays.length).toBe(4); // 3 retried attempts + 1 resume
    expect(new Set(pays.map((c) => c[0].partnerReferenceNo))).toEqual(new Set(["RD-1-PAY"]));
  });

  function sweepWorld(opts: {
    livePoints: string; fiatAvailable: string; journal: any[];
    pgFees?: Array<{ amountIdr: string }>; legs?: number;
  }) {
    const { service, prisma, sac } = setup({ PID_REDEMPTION_ENABLED: "true" });
    prisma.fiatProviderAccount.count.mockResolvedValue(1);
    prisma.fiatProviderAccount.findMany.mockResolvedValue([{ pid: "alice@pid" }]);
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    (prisma.fiatProviderTransaction.findMany as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.kind === "redemption") return [];
      if (args?.select?.amountIdr && args?.where?.kind === "points_fee") return [];
      return opts.journal;
    });
    (prisma.fiatProviderTransaction.count as jest.Mock).mockResolvedValue(opts.legs ?? opts.journal.length);
    (sac.balance as jest.Mock).mockResolvedValue({
      profileId: "PROF1",
      accounts: [
        { type: "DOKU_MERCHANT_IDR", currency: "IDR", accountNo: "1140340010", available: opts.fiatAvailable, reserved: "0.00" },
        { type: "DOKU_MERCHANT_PENDING_IDR", currency: "IDR", accountNo: "1140340011", available: "0.00", reserved: "0.00" },
        { type: "DOKU_MERCHANT_POINT", currency: "POINT", accountNo: "2211403401", available: opts.livePoints, reserved: "0.00" },
      ],
      rawResponse: {},
    });
    (sac.history as jest.Mock).mockResolvedValue({
      items: (opts.pgFees ?? []).map((f, i) => ({
        mutationType: "CREDIT", transactionType: "SETTLEMENT_FEE", amount: 0,
        amountIdr: f.amountIdr, currency: "IDR", status: "SUCCESS",
        partnerReferenceNo: `PG${i}`, referenceNo: `DOKU-PG${i}`,
      })),
      rawResponse: {},
    });
    return { service, prisma, sac };
  }

  const OUTSTANDING_JOURNAL = [
    { kind: "points_issue", pid: "alice@pid", providerRef: "DP1-PTS", providerStatus: "settled", amountIdr: 100000n, direction: "in", entryGroup: "DP1", extinguished: false, counterparty: null, replaySeq: 1n },
    { kind: "points_fee", pid: "alice@pid", providerRef: "DP1-PTS-FEE", providerStatus: "settled", amountIdr: 5000n, direction: "out", entryGroup: "DP1", extinguished: false, counterparty: { destination: "treasury" }, replaySeq: 2n },
  ];

  it("aggregate verdict ok when the gap maps exactly to observed PG fees", async () => {
    // Outstanding 105000 (100k alice + 5k treasury), live alice 100000
    // (invariant-1 holds), fiat backing 102000, PG observed 3000.
    const { service } = sweepWorld({ livePoints: "100000.00", fiatAvailable: "102000.00", journal: OUTSTANDING_JOURNAL, pgFees: [{ amountIdr: "3000" }], legs: 2 });
    const out = await service.adminSweep({ take: 5 });
    expect(out.aggregate.verdict).toMatch(/^ok:/);
    expect(out.aggregate.adjustments[0]).toMatchObject({ kind: "pg_observed_settlement_fees", amountIdr: "3000" });
    expect(out.aggregate.adjustments[1]).toMatchObject({ kind: "platform_reserve", amountIdr: "0" });
    expect(out.aggregate.adjustments[2]).toMatchObject({ kind: "rounding_allowance", amountIdr: "2", legs: 2 });
    expect(out.aggregate.unexplainedIdr).toBe("0");
    expect(out.redemptionHalted).toBe(false);
  });

  it("aggregate ALERTs and halts on unexplained gap; halt blocks redemption, admin clears", async () => {
    // Same books, but DOKU shows no PG rows → 3000 unexplained (> Rp1 x 2 legs).
    const { service, prisma, sac } = sweepWorld({ livePoints: "100000.00", fiatAvailable: "102000.00", journal: OUTSTANDING_JOURNAL, pgFees: [], legs: 2 });
    const out = await service.adminSweep({ take: 5 });
    expect(out.aggregate.verdict).toMatch(/^ALERT:/);
    expect(out.aggregate.unexplainedIdr).toBe("3000");
    expect(out.redemptionHalted).toBe(true);
    // Halted redemptions fail fast with 503 even though the flag is on.
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    await expect(service.requestRedemption("alice@pid", {
      amountIdr: "1000", bankCode: "014", bankAccountNumber: "1", bankAccountName: "A",
    })).rejects.toMatchObject({ status: 503 });
    expect(sac.debit).not.toHaveBeenCalled();
    // Admin clears after review → redemptions flow again (fails later on
    // balance here, but passes the halt gate).
    expect(service.setRedemptionHalt(false, "ops reviewed test")).toMatchObject({ halted: false });
    (prisma.fiatProviderTransaction.findMany as jest.Mock).mockResolvedValue([]);
    await expect(service.requestRedemption("alice@pid", {
      amountIdr: "1000", bankCode: "014", bankAccountNumber: "1", bankAccountName: "B",
    })).rejects.toMatchObject({ status: 400 });
  });

  it("rounding allowance covers Rp1-per-leg representation drift, nothing more", async () => {
    // Outstanding 105000, PG 3000 observed. Fiat 101998 → gap 3002,
    // unexplained 2 ≤ 2 legs → ok. Fiat 101997 → unexplained 3 → ALERT.
    // Live always equals replay (invariant-1 holds throughout).
    const { service } = sweepWorld({ livePoints: "100000.00", fiatAvailable: "101998.00", journal: OUTSTANDING_JOURNAL, pgFees: [{ amountIdr: "3000" }], legs: 2 });
    const out = await service.adminSweep({ take: 5 });
    expect(out.aggregate.verdict).toMatch(/^ok:/);
    const again = sweepWorld({ livePoints: "100000.00", fiatAvailable: "101997.00", journal: OUTSTANDING_JOURNAL, pgFees: [{ amountIdr: "3000" }], legs: 2 });
    const out2 = await again.service.adminSweep({ take: 5 });
    expect(out2.aggregate.verdict).toMatch(/^ALERT:/);
    expect(out2.aggregate.unexplainedIdr).toBe("3");
  });

  it("clawback debits issued points and marks the parent clawed_back when whole", async () => {    const { service, prisma, sac } = setup({ DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001" });
    const parent = {
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
      ledgerStatus: "issued", ledgerRef: "DP1-PTS", settlementStatus: "pending",
      counterparty: {}, providerResponse: {},
    };
    prisma.fiatProviderTransaction.findUnique.mockResolvedValue(parent);
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.findMany.mockResolvedValue([]);
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => ({ id: "c1", providerStatus: "created", createdAt: new Date(), ...args.data }));
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => (
      args?.where?.id === "c1"
        ? { id: "c1", kind: "points_clawback", providerRef: "DP1-CLAWBACK-1", amountIdr: 100000n, feeIdr: null, netIdr: 100000n, createdAt: new Date(), ...args.data }
        : { ...parent, ...args.data }
    ));
    const view = await service.clawbackPoints({ transactionId: "d1", amountIdr: "100000", reason: "chargeback" });
    expect(sac.debit).toHaveBeenCalledWith(expect.objectContaining({
      partnerReferenceNo: "DP1-CLAWBACK-1", fromAccount: "2211403401", amountIdr: 100000n, currency: "POINT",
    }));
    expect(view.providerRef).toBe("DP1-CLAWBACK-1");
    expect(prisma.fiatProviderTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1" }, data: expect.objectContaining({ ledgerStatus: "clawed_back" }) }),
    );
  });

  it("clawback refuses deposits with nothing issued", async () => {
    const { service, prisma } = setup();
    prisma.fiatProviderTransaction.findUnique.mockResolvedValue({
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, createdAt: new Date(), ledgerStatus: "pending", counterparty: {},
    });
    await expect(service.clawbackPoints({ transactionId: "d1", amountIdr: "100000" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("syncTx settles on 00 and stays processing on unknown codes", async () => {
    const { service, prisma, sac } = setup();
    const processing = {
      id: "t1", pid: "ifal@pid", kind: "transfer_internal", providerRef: "ST1", providerStatus: "processing",
      amountIdr: 50000n, feeIdr: 2500n, netIdr: 47500n, createdAt: new Date(), providerResponse: {},
    };
    prisma.fiatProviderTransaction.findFirst
      .mockResolvedValueOnce(processing) // part 1: sync row
      .mockResolvedValueOnce({ ...processing, providerStatus: "settled" }) // part 1: post-sync re-read
      .mockResolvedValueOnce(processing) // part 2: sync row
      .mockResolvedValue(processing); // part 2: re-read and beyond
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => ({
      ...processing, ...args.data,
    }));
    (sac.txStatus as jest.Mock).mockResolvedValueOnce({ partnerReferenceNo: "ST1", latestTransactionStatus: "00", rawResponse: {} });
    expect((await service.syncTx("ifal@pid", "t1")).providerStatus).toBe("settled");
    (sac.txStatus as jest.Mock).mockResolvedValueOnce({ partnerReferenceNo: "ST1", latestTransactionStatus: "99", rawResponse: {} });
    expect((await service.syncTx("ifal@pid", "t1")).providerStatus).toBe("processing");
  });

  it("syncTx issues NET user points + FEE Treasury points on a paid deposit", async () => {
    const { service, prisma, sac } = setup({
      DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001",
      DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999",
    });
    const created = {
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "created",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, feePolicyVersion: 3, createdAt: new Date(),
      ledgerStatus: "pending", settlementStatus: "pending",
      counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
      providerResponse: {},
    };
    const settled = { ...created, providerStatus: "settled" };
    let reads = 0;
    (prisma.fiatProviderTransaction.findFirst as jest.Mock).mockImplementation(async (args: any) => {
      // Leg lookups (points_issue/points_fee) find nothing — fresh issuance.
      if (args?.where?.kind === "points_issue" || args?.where?.kind === "points_fee") return null;
      reads++;
      return reads === 1 ? created : { ...settled, ledgerStatus: "issued" };
    });
    prisma.fiatProviderTransaction.findUnique.mockResolvedValue(settled);
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => ({ id: "leg", providerStatus: "created", createdAt: new Date(), ...args.data }));
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => ({ ...settled, ...args.data }));
    (sac.txStatus as jest.Mock).mockResolvedValue({
      partnerReferenceNo: "DP1", latestTransactionStatus: "00",
      amount: { value: "105000.00", currency: "IDR" }, rawResponse: {},
    });
    const view = await service.syncTx("ifal@pid", "d1");
    expect(view.providerStatus).toBe("settled");
    // User leg: NET points from SYSTEM_POINT to the user POINT account.
    expect(sac.transferPayment).toHaveBeenCalledWith(expect.objectContaining({
      partnerReferenceNo: "DP1-PTS", type: "DOKU_NON_FIAT", amountIdr: 100000n,
      currency: "POINT", fromAccount: "9900000001", beneficiaryAccountNumber: "2211403401",
    }));
    // Treasury leg: FEE points to the Treasury POINT account.
    expect(sac.transferPayment).toHaveBeenCalledWith(expect.objectContaining({
      partnerReferenceNo: "DP1-PTS-FEE", type: "DOKU_NON_FIAT", amountIdr: 5000n,
      currency: "POINT", beneficiaryAccountNumber: "2299999999",
    }));
    expect(prisma.fiatProviderTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1" }, data: expect.objectContaining({ ledgerStatus: "issued" }) }),
    );
  });

  it("issuance is blocked when the corroborated amount mismatches the invoice", async () => {
    const { service, prisma, sac } = setup({
      DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001",
      DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999",
    });
    const settled = {
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, feePolicyVersion: 3, createdAt: new Date(),
      ledgerStatus: "pending", settlementStatus: "pending",
      counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
      providerResponse: {},
    };
    // syncTx sees created → corroborates → settles; issuance re-reads settled.
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue({ ...settled, providerStatus: "created" });
    prisma.fiatProviderTransaction.findUnique.mockResolvedValue(settled);
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    (sac.txStatus as jest.Mock).mockResolvedValue({
      partnerReferenceNo: "DP1", latestTransactionStatus: "00",
      amount: { value: "100000.00", currency: "IDR" }, rawResponse: {},
    });
    await service.syncTx("ifal@pid", "d1");
    const pointCalls = (sac.transferPayment as jest.Mock).mock.calls.filter((c) => c[0]?.type === "DOKU_NON_FIAT");
    expect(pointCalls).toHaveLength(0);
    expect(prisma.fiatProviderTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "d1" }, data: expect.objectContaining({ ledgerStatus: "blocked" }) }),
    );
  });

  it("issuance never double-issues an already-issued deposit", async () => {
    const { service, prisma, sac } = setup({
      DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001",
      DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999",
    });
    const issued = {
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(),
      ledgerStatus: "issued", ledgerRef: "DP1-PTS", settlementStatus: "pending",
      counterparty: {}, providerResponse: {},
    };
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue(issued);
    prisma.fiatProviderTransaction.findUnique.mockResolvedValue(issued);
    await service.syncTx("ifal@pid", "d1");
    const pointCalls = (sac.transferPayment as jest.Mock).mock.calls.filter((c) => c[0]?.type === "DOKU_NON_FIAT");
    expect(pointCalls).toHaveLength(0);
    expect(sac.transferInquiry).not.toHaveBeenCalled();
  });

  it("webhook settle issues points fire-and-forget (no fiat fee debit)", async () => {
    const { service, prisma, sac } = setup({
      DOKU_SYSTEM_POINT_ACCOUNT_NO: "9900000001",
      DOKU_TREASURY_POINT_ACCOUNT_NO: "2299999999",
    });
    const created = {
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "created",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, feePolicyVersion: 3, createdAt: new Date(),
      ledgerStatus: "pending", settlementStatus: "pending",
      counterparty: { channel: "checkout", feeQuote: "5000", netQuote: "100000", feePolicyVersion: 3 },
      providerResponse: {},
    };
    (prisma.fiatProviderTransaction.findUnique as jest.Mock).mockImplementation(async (args: any) => {
      if (args?.where?.providerRef) return created; // webhook row lookup
      return { ...created, providerStatus: "settled" }; // issuance re-read
    });
    prisma.fiatProviderAccount.findUnique.mockResolvedValue({ ...ACTIVE });
    prisma.fiatProviderTransaction.create.mockImplementation(async (args: any) => ({ id: "leg", providerStatus: "created", createdAt: new Date(), ...args.data }));
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => ({ ...created, ...args.data }));
    (sac.txStatus as jest.Mock).mockResolvedValue({
      partnerReferenceNo: "DP1", latestTransactionStatus: "00",
      amount: { value: "105000.00", currency: "IDR" }, rawResponse: {},
    });
    await expect(service.webhook("ext-auto", JSON.stringify({ partnerReferenceNo: "DP1" }))).resolves.toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 100)); // let the fire-and-forget issuance land
    expect(sac.debit).not.toHaveBeenCalled();
    expect(sac.transferPayment).toHaveBeenCalledWith(expect.objectContaining({
      partnerReferenceNo: "DP1-PTS", type: "DOKU_NON_FIAT", amountIdr: 100000n, currency: "POINT",
    }));
    expect(prisma.fiatWebhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ where: { externalId: "ext-auto" } }));
  });

  it("syncTx on an unpaid Checkout intent says Not paid yet (no 404 dump, row untouched)", async () => {
    const { service, prisma, sac } = setup();
    const { ProviderError } = await import("@peridotvault/pid-payments");
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue({
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "created",
      amountIdr: 100000n, feeIdr: null, netIdr: null, createdAt: new Date(),
      providerResponse: { response: { payment: { url: "https://pay.example/1" } } },
    });
    (sac.txStatus as jest.Mock).mockRejectedValue(new ProviderError(404, "Transaction Not Found"));
    await expect(service.syncTx("ifal@pid", "d1")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("Not paid yet"),
    });
    expect(prisma.fiatProviderTransaction.update).not.toHaveBeenCalled();
  });

  it("toTxView carries the Checkout paymentUrl for reopening payment", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue({
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "processing",
      amountIdr: 100000n, feeIdr: null, netIdr: null, createdAt: new Date(),
      providerResponse: { response: { payment: { url: "https://pay.example/1" } } },
    });
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => ({
      id: "d1", kind: "deposit", providerRef: "DP1", amountIdr: 100000n, feeIdr: null, netIdr: null,
      createdAt: new Date(), ...args.data,
      providerResponse: { response: { payment: { url: "https://pay.example/1" } } },
    }));
    (sac.txStatus as jest.Mock).mockResolvedValueOnce({ partnerReferenceNo: "DP1", latestTransactionStatus: "03", rawResponse: {} });
    const view = await service.syncTx("ifal@pid", "d1");
    expect(view.paymentUrl).toBe("https://pay.example/1");
  });

  it("txs() attaches fee-leg statuses, null when no leg exists", async () => {
    const { service, prisma } = setup();
    const settled = {
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(), providerResponse: {},
    };
    const created = {
      id: "d2", pid: "ifal@pid", kind: "deposit", providerRef: "DP2", providerStatus: "created",
      amountIdr: 105000n, feeIdr: null, netIdr: null, createdAt: new Date(), providerResponse: {},
    };
    prisma.fiatProviderTransaction.findMany
      .mockResolvedValueOnce([settled, created]) // txs() rows
      .mockResolvedValueOnce([{ providerRef: "DP1-FEE", providerStatus: "failed" }]); // legs
    const views = await service.txs("ifal@pid");
    expect(views.find((v) => v.providerRef === "DP1")?.feeStatus).toBe("failed");
    expect(views.find((v) => v.providerRef === "DP2")?.feeStatus).toBeNull();
  });

  it("syncTx carries the fee-leg status for the retry rule", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue({
      id: "d1", pid: "ifal@pid", kind: "deposit", providerRef: "DP1", providerStatus: "settled",
      amountIdr: 105000n, feeIdr: 5000n, netIdr: 100000n, createdAt: new Date(), providerResponse: {},
    });
    prisma.fiatProviderTransaction.findMany.mockResolvedValueOnce([
      { providerRef: "DP1-FEE", providerStatus: "settled" },
    ]);
    const view = await service.syncTx("ifal@pid", "d1");
    expect(view.feeStatus).toBe("settled");
    expect(sac.txStatus).not.toHaveBeenCalled(); // settled row: no status poll
  });

  it("toTxView leaves paymentUrl null for non-Checkout rows", async () => {
    const { service, prisma, sac } = setup();
    prisma.fiatProviderTransaction.findFirst.mockResolvedValue({
      id: "t1", pid: "ifal@pid", kind: "transfer_internal", providerRef: "ST1", providerStatus: "processing",
      amountIdr: 50000n, feeIdr: null, netIdr: null, createdAt: new Date(), providerResponse: {},
    });
    prisma.fiatProviderTransaction.update.mockImplementation(async (args: any) => ({
      id: "t1", kind: "transfer_internal", providerRef: "ST1", amountIdr: 50000n, feeIdr: null, netIdr: null,
      providerResponse: {}, createdAt: new Date(), ...args.data,
    }));
    (sac.txStatus as jest.Mock).mockResolvedValueOnce({ partnerReferenceNo: "ST1", latestTransactionStatus: "03", rawResponse: {} });
    expect((await service.syncTx("ifal@pid", "t1")).paymentUrl).toBeNull();
  });
});
