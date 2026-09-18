import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PaymentProvider } from "@peridotvault/pid-payments";
import { FiatService } from "./fiat.service";

function configStub() {
  const store: Record<string, string> = { FIAT_CALLBACK_URL: "http://localhost:8081/fiat/result" };
  return { get: (k: string, d?: string) => store[k] ?? d ?? "" } as unknown as ConfigService;
}

function providerStub() {
  return {
    name: "stub",
    createInvoice: jest.fn(async (input: { invoiceNumber: string }) => ({
      paymentUrl: `https://pay.example/${input.invoiceNumber}`,
      rawResponse: { stub: true },
    })),
    verifyWebhook: jest.fn((_h: unknown, _b: string, _p: string) => true),
    parseWebhook: jest.fn((_b: string) => null),
  } as unknown as jest.Mocked<PaymentProvider>;
}

function setup() {
  // ponytail: any-typed mock — shapes vary per test, strictness adds nothing here.
  const prisma: any = {
    fiatTopup: {
      create: jest.fn(async (args: any) => ({ id: "t1", status: "pending", paymentUrl: null, paidAt: null, ...args.data })),
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async (args: any) => ({
        id: "t1",
        invoiceNumber: "INV",
        amountIdr: 50000n,
        provider: "stub",
        status: "pending",
        paymentUrl: null,
        expiresAt: null,
        paidAt: null,
        createdAt: new Date(),
        ...args.data,
      })),
      aggregate: jest.fn(async () => ({ _sum: { amountIdr: null } })),
    },
    fiatWithdraw: {
      create: jest.fn(async (args: any) => ({ id: "w1", status: "pending", createdAt: new Date(), ...args.data })),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async (args: any) => ({ id: "w1", amountIdr: 40000n, createdAt: new Date(), ...args.data })),
      aggregate: jest.fn(async () => ({ _sum: { amountIdr: null } })),
    },
  };
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));
  const provider = providerStub();
  const service = new FiatService(prisma as never, configStub(), provider);
  return { service, prisma, provider };
}

describe("FiatService", () => {
  it("createTopup stores the provider name and returns its payment page", async () => {
    const { service, prisma, provider } = setup();
    const view = await service.createTopup("ifal@pid", "50000");
    expect(prisma.fiatTopup.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ provider: "stub" }) }),
    );
    expect(provider.createInvoice).toHaveBeenCalledWith(expect.objectContaining({ amountIdr: 50000n }));
    expect(view.paymentUrl).toMatch(/^https:\/\/pay\.example\//);
    expect(view.provider).toBe("stub");
  });

  it("createTopup maps provider failure to 503", async () => {
    const { service, provider } = setup();
    provider.createInvoice.mockRejectedValueOnce(new Error("gateway down"));
    await expect(service.createTopup("ifal@pid", "50000")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("webhook applies the parsed event and is idempotent on replay", async () => {
    const { service, prisma, provider } = setup();
    provider.parseWebhook.mockReturnValue({ invoiceNumber: "PIDABC123", status: "paid", rawResponse: {} });
    prisma.fiatTopup.findUnique.mockResolvedValue({ id: "t1", invoiceNumber: "PIDABC123", amountIdr: 10000n, provider: "stub", status: "pending" });

    await expect(service.webhook("stub", {}, "{}", "/v1/fiat/webhook/stub")).resolves.toEqual({ ok: true });
    expect(prisma.fiatTopup.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "paid" }) }),
    );

    // Replay after paid: acked without a second write.
    const { service: s2, prisma: p2, provider: pr2 } = setup();
    pr2.parseWebhook.mockReturnValue({ invoiceNumber: "PIDABC123", status: "paid", rawResponse: {} });
    p2.fiatTopup.findUnique.mockResolvedValue({ id: "t1", status: "paid" });
    await expect(s2.webhook("stub", {}, "{}", "/v1/fiat/webhook/stub")).resolves.toEqual({ ok: true });
    expect(p2.fiatTopup.update).not.toHaveBeenCalled();
  });

  it("webhook rejects wrong provider, bad signature, unparseable bodies, unknown invoices", async () => {
    const { service, prisma, provider } = setup();
    await expect(service.webhook("other", {}, "{}", "/x")).resolves.toEqual({ ok: false });

    provider.verifyWebhook.mockReturnValueOnce(false);
    await expect(service.webhook("stub", {}, "{}", "/x")).resolves.toEqual({ ok: false });

    provider.parseWebhook.mockReturnValueOnce(null);
    await expect(service.webhook("stub", {}, "{}", "/x")).resolves.toEqual({ ok: false });

    provider.parseWebhook.mockReturnValueOnce({ invoiceNumber: "NOPE", status: "paid", rawResponse: {} });
    prisma.fiatTopup.findUnique.mockResolvedValueOnce(null);
    await expect(service.webhook("stub", {}, "{}", "/x")).resolves.toEqual({ ok: false });
  });

  it("balance subtracts pending + settled withdraws from paid top-ups", async () => {
    const { service, prisma } = setup();
    prisma.fiatTopup.aggregate.mockResolvedValue({ _sum: { amountIdr: 100000n } });
    prisma.fiatWithdraw.aggregate.mockResolvedValue({ _sum: { amountIdr: 30000n } });
    await expect(service.balance("ifal@pid")).resolves.toEqual({ availableIdr: "70000", currency: "IDR" });
  });

  it("requestWithdraw succeeds within balance and debits it afterwards", async () => {
    const { service, prisma } = setup();
    prisma.fiatTopup.aggregate.mockResolvedValue({ _sum: { amountIdr: 100000n } });
    prisma.fiatWithdraw.aggregate.mockResolvedValue({ _sum: { amountIdr: null } });
    const view = await service.requestWithdraw("ifal@pid", "40000");
    expect(view.amountIdr).toBe("40000");
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("requestWithdraw rejects overdraft without inserting", async () => {
    const { service, prisma } = setup();
    prisma.fiatTopup.aggregate.mockResolvedValue({ _sum: { amountIdr: 10000n } });
    prisma.fiatWithdraw.aggregate.mockResolvedValue({ _sum: { amountIdr: null } });
    await expect(service.requestWithdraw("ifal@pid", "50000")).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.fiatWithdraw.create).not.toHaveBeenCalled();
  });

  it("settleWithdraw transitions pending once and is idempotent", async () => {
    const { service, prisma } = setup();
    prisma.fiatWithdraw.findUnique.mockResolvedValue({ id: "w1", amountIdr: 40000n, status: "pending", createdAt: new Date() });
    const settled = await service.settleWithdraw("w1", "settled");
    expect(settled.status).toBe("settled");

    prisma.fiatWithdraw.findUnique.mockResolvedValue({ id: "w1", amountIdr: 40000n, status: "settled", createdAt: new Date() });
    await expect(service.settleWithdraw("w1", "rejected")).resolves.toMatchObject({ status: "settled" });
    expect(prisma.fiatWithdraw.update).toHaveBeenCalledTimes(1);
  });

  it("settleWithdraw 404s unknown ids", async () => {
    const { service } = setup();
    await expect(service.settleWithdraw("nope", "settled")).rejects.toBeInstanceOf(NotFoundException);
  });
});
