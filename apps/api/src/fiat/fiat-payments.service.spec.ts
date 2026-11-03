import { FiatPaymentsService } from "./fiat-payments.service";
import { replayFiatLedger } from "./fiat-ledger-replay";

function setup() {
  let payment: any;
  const entries: any[] = [], events: any[] = [];
  const app = { clientId: "pidapp_kinno", ownerPid: "kinno@pid", isActive: true, webhookUrl: "https://kinno.example/hook" };
  const prisma: any = {
    pidApp: { findUnique: jest.fn(async () => app), findUniqueOrThrow: jest.fn(async () => app) },
    identity: { findUnique: jest.fn(async () => ({})) },
    fiatPayment: {
      findUnique: jest.fn(async () => payment ?? null), findUniqueOrThrow: jest.fn(async () => payment),
      create: jest.fn(async ({ data }) => payment = { ...data, status: "created", refundedIdr: 0n, createdAt: new Date(), nextCheckAt: new Date(), paidAt: null }),
      update: jest.fn(async ({ data }) => payment = { ...payment, ...data, refundedIdr: data.refundedIdr ? payment.refundedIdr + data.refundedIdr.increment : payment.refundedIdr }),
      updateMany: jest.fn(async ({ data }) => { payment = { ...payment, ...data }; return { count: 1 }; }),
    },
    fiatLedgerEntry: { findUnique: jest.fn(async ({ where }) => entries.find(e => e.idempotencyKey === where.idempotencyKey) ?? null) },
    fiatLedgerEvent: { create: jest.fn(async ({ data }) => { events.push(data); }) },
    $executeRaw: jest.fn(),
  };
  let tail = Promise.resolve();
  prisma.$transaction = jest.fn((fn) => {
    const run = tail.then(() => fn(prisma)); tail = run.catch(() => {}); return run;
  });
  const ledger: any = {
    ledgerEnabled: () => true, ledgerFrozen: () => false,
    appendChained: jest.fn(async (_tx, legs) => entries.push(...legs.map((l: any) => ({ ...l.data, status: "posted" })))),
    lockAccounts: jest.fn(), postedBalanceTx: jest.fn(async () => 10000n),
  };
  const quote = { amountIdr: "10000", netIdr: "10000", totalIdr: "10100", minimumIdr: "10000", peridotFeeIdr: "100", peridotTaxIdr: "0", appFeeIdr: "0" };
  const fiat: any = { quoteDeposit: jest.fn(async () => quote) };
  const checkout: any = { createPayment: jest.fn(async () => ({ paymentUrl: "https://pay.example" })), checkOrderStatus: jest.fn(async () => ({ paid: true, paidAmount: 10100n })) };
  const service = new FiatPaymentsService(prisma, { get: (_k: string, d: string) => d } as never, ledger, fiat, checkout);
  return { service, prisma, ledger, checkout, entries, events, current: () => payment };
}
const user = { pid: "kinno@pid", app: "pidapp_kinno", scope: "fiat:payment" };
const input = { amountIdr: "10000", externalId: "ORDER-1", payerPid: "alice@pid", metadata: { plan: "pro" }, paymentMethod: "QRIS" };

describe("direct app payments", () => {
  it("creates without payer balance and replays the same invoice", async () => {
    const x = setup();
    const first = await x.service.create(user, input);
    const second = await x.service.create(user, input);
    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ netIdr: "10000", totalIdr: "10100", metadata: { plan: "pro" } });
    expect(x.checkout.createPayment).toHaveBeenCalledTimes(1);
    expect(x.ledger.postedBalanceTx).not.toHaveBeenCalled();
  });
  it("rejects changed amount for an existing externalId", async () => {
    const x = setup(); await x.service.create(user, input);
    await expect(x.service.create(user, { ...input, amountIdr: "20000" })).rejects.toThrow("externalId");
  });
  it("concurrent confirmations credit once and enqueue a paid event", async () => {
    const x = setup(); await x.service.create(user, input);
    await Promise.all([x.service.sync(x.current()), x.service.sync(x.current())]);
    expect(x.entries.filter(e => e.kind === "fiat_payment_in")).toHaveLength(1);
    expect(x.events).toHaveLength(1);
    expect(x.events[0].payload).toMatchObject({ type: "fiat.payment.paid", externalId: "ORDER-1", payerPid: "alice@pid" });
    const replay = replayFiatLedger(x.entries);
    expect(replay.balances.get("kinno@pid")).toBe(10000n);
    expect(replay.treasury).toBe(100n);
    expect(replay.errors).toEqual([]);
  });
  it("does not credit an unconfirmed or mismatched amount", async () => {
    const x = setup(); await x.service.create(user, input);
    x.checkout.checkOrderStatus.mockResolvedValueOnce({ paid: false, paidAmount: null });
    await x.service.sync(x.current());
    x.checkout.checkOrderStatus.mockResolvedValueOnce({ paid: true, paidAmount: 10000n });
    await x.service.sync(x.current()); expect(x.entries).toHaveLength(0);
  });
  it("refunds partial once and rejects an over-refund", async () => {
    const x = setup(); const p = await x.service.create(user, input); await x.service.sync(x.current());
    await x.service.refund(user, p.id, { requestId: "R1", amountIdr: "4000" });
    await x.service.refund(user, p.id, { requestId: "R1", amountIdr: "4000" });
    expect(x.entries.filter(e => e.kind === "fiat_adjust")).toHaveLength(2);
    await expect(x.service.refund(user, p.id, { requestId: "R2", amountIdr: "7000" })).rejects.toThrow("remaining");
    expect(replayFiatLedger(x.entries).balances.get("alice@pid")).toBe(4000n);
  });
  it("rejects another app and a payer attempting a refund", async () => {
    const x = setup(); const p = await x.service.create(user, input);
    await expect(x.service.get({ ...user, app: "other" }, p.id)).rejects.toThrow("not found");
    await expect(x.service.refund({ pid: "alice@pid" }, p.id, { requestId: "R1" })).rejects.toThrow("beneficiary");
    await expect(x.service.create({ ...user, scope: "fiat:transfer" }, input)).rejects.toThrow("scope");
  });
  it("limits metadata by UTF-8 bytes", async () => {
    const x = setup();
    await expect(x.service.create(user, { ...input, metadata: { text: "🟢".repeat(600) } })).rejects.toThrow("2KB");
  });
  it("requires a payment method and a global ceiling", async () => {
    const x = setup();
    await expect(x.service.create(user, { ...input, paymentMethod: undefined })).rejects.toThrow("paymentMethod");
    await expect(x.service.create(user, { ...input, externalId: "ORDER-2", amountIdr: "10000001" })).rejects.toMatchObject({
      response: { code: "PAYMENT_ABOVE_CEILING", maximumIdr: "10000000" },
    });
  });
  it("accepts any registered identity as beneficiary (no operator allowlist)", async () => {
    const x = setup();
    await expect(x.service.create(user, { ...input, beneficiaryPid: "creator@pid" })).resolves.toMatchObject({ beneficiaryPid: "creator@pid" });
  });
  it("rejects an unknown beneficiary identity", async () => {
    const x = setup();
    x.prisma.identity.findUnique.mockResolvedValueOnce(null);
    await expect(x.service.create(user, input)).rejects.toThrow("Identity unavailable");
  });
  it("expires unpaid intents and removes the returned payment URL", async () => {
    const x = setup(); const p = await x.service.create(user, input);
    x.current().expiresAt = new Date(0);
    x.checkout.checkOrderStatus.mockResolvedValue({ paid: false, expired: true });
    await x.service.sync(x.current());
    expect(await x.service.get(user, p.id)).toMatchObject({ status: "expired", paymentUrl: null });
    expect(x.events[0].eventType).toBe("fiat.payment.expired");
  });
  it("keeps a cancelled payment cancelled instead of expiring it", async () => {
    const x = setup(); await x.service.create(user, input);
    x.current().status = "cancelled"; x.current().expiresAt = new Date(0);
    x.checkout.checkOrderStatus.mockResolvedValue({ paid: false, expired: true });
    await x.service.sync(x.current());
    expect(x.current().status).toBe("cancelled");
    expect(x.events).toHaveLength(0);
  });
  it("closes a mismatched paid order as failed instead of polling it forever", async () => {
    const x = setup(); await x.service.create(user, input);
    x.checkout.checkOrderStatus.mockResolvedValueOnce({ paid: true, paidAmount: 9999n });
    await x.service.sync(x.current());
    expect(x.current().status).toBe("failed");
    expect(x.events[0].eventType).toBe("fiat.payment.failed");
    expect(x.entries).toHaveLength(0);
  });
});
