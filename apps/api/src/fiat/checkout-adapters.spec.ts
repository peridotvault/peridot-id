import { DokuCheckoutClient, type CheckoutAdapter } from "@peridotvault/pid-payments";
import { createCheckoutAdapters, DOKU_CHECKOUT_PROVIDER } from "./checkout-adapters";

const creds = { mode: "sandbox" as const, clientId: "C", secretKey: "S" };

describe("checkout adapter wiring", () => {
  it("defaults to DOKU and exposes it under its routing name", () => {
    const { adapters, active } = createCheckoutAdapters(creds);
    expect(active.name).toBe(DOKU_CHECKOUT_PROVIDER);
    expect(adapters[DOKU_CHECKOUT_PROVIDER]).toBe(active);
  });

  it("fails closed on an unknown provider instead of falling back", () => {
    expect(() => createCheckoutAdapters({ ...creds, provider: "stripe" })).toThrow(/Unknown PAYMENT_CHECKOUT_PROVIDER/);
  });

  it("implements the provider-neutral contract", () => {
    const adapter: CheckoutAdapter = createCheckoutAdapters(creds).active;
    for (const method of ["createPayment", "checkOrderStatus", "transactionFee", "parseNotification"] as const) {
      expect(typeof adapter[method]).toBe("function");
    }
  });
});

describe("DOKU notification normalization", () => {
  const doku = createCheckoutAdapters(creds).active;

  it("keeps documented fields and the raw amount", () => {
    expect(doku.parseNotification({ order: { invoice_number: "INV-1", amount: 150000 }, transaction: { status: "SUCCESS" } })).toEqual({
      invoiceNumber: "INV-1",
      amountRaw: 150000,
      txStatus: "SUCCESS",
    });
  });

  it("returns null when the body names no invoice (caller never infers payment)", () => {
    expect(doku.parseNotification({ order: { amount: 150000 } })).toBeNull();
    expect(doku.parseNotification("not json")).toBeNull();
    expect(doku.parseNotification(null)).toBeNull();
  });

  it("is the class the wiring uses", () => {
    expect(doku).toBeInstanceOf(DokuCheckoutClient);
  });
});
