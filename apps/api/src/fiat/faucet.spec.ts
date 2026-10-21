import { NotFoundException, UnprocessableEntityException, ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TestCreditDto } from "./dto/faucet.dto";
import { FiatLedgerService } from "./fiat-ledger.service";

function configStub(store: Record<string, string> = {}) {
  const base: Record<string, string> = { PID_FIAT_LEDGER_ENABLED: "true", DOKU_MODE: "sandbox", ...store };
  return { get: (k: string, d?: string) => base[k] ?? d ?? "" } as unknown as ConfigService;
}

function setup(store?: Record<string, string>, todays: Array<{ amountIdr: bigint }> = []) {
  const created: any[] = [];
  const txEntry = {
    findFirst: jest.fn(async () => null), // no chain head → GENESIS_HASH
    findMany: jest.fn(async () => todays),
    create: jest.fn(async (args: any) => {
      const r = { id: `j${created.length}`, createdAt: new Date(), ...args.data };
      created.push(r);
      return r;
    }),
  };
  const prisma: any = {
    fiatLedgerEntry: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: any) => fn({
      fiatLedgerEntry: txEntry,
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async () => 1),
    })),
  };
  const security = { log: jest.fn(async () => undefined) };
  const service = new FiatLedgerService(prisma as never, configStub(store), {} as never, security as never);
  return { service, prisma, created, security, txEntry };
}

async function codeOf(p: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await p;
    throw new Error("expected throw");
  } catch (e: any) {
    return { status: e?.status ?? e?.getStatus?.() ?? 0, body: e?.response ?? null };
  }
}

describe("FiatLedgerService.mintTestCredit (sandbox faucet)", () => {
  it("mints a posted fiat_issue leg and audits it", async () => {
    const { service, created, security } = setup();
    const out = await service.mintTestCredit("dev@pid", 50000);
    expect(out).toMatchObject({ amountMinor: "50000", currency: "IDR", env: "sandbox", dailyRemainingMinor: "50000" });
    expect(out.creditId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "fiat_issue", pid: "dev@pid", direction: "in", status: "posted", source: "faucet" });
    expect(created[0].amountIdr).toBe(50_000n);
    expect(security.log).toHaveBeenCalledWith("dev@pid", "fiat.faucet_minted", expect.objectContaining({ amountMinor: "50000" }));
  });

  it.each([null, undefined, 0, -5, 50001, 100000, "abc", "", 1.5, NaN, {}, []])(
    "rejects invalid amount %p with 422",
    async (bad) => {
      const { service, created } = setup();
      const { status, body } = await codeOf(service.mintTestCredit("dev@pid", bad));
      expect(status).toBe(422);
      expect(body).toMatchObject({ error: "faucet_invalid_amount" });
      expect(created).toHaveLength(0);
    },
  );

  it("accepts numeric strings at the boundary", async () => {
    const { service } = setup();
    const out = await service.mintTestCredit("dev@pid", "50000");
    expect(out.amountMinor).toBe("50000");
    expect(out.dailyRemainingMinor).toBe("50000");
  });

  it("enforces the daily cap with remaining quota", async () => {
    const { service, created } = setup({}, [{ amountIdr: 60_000n }]);
    const { status, body } = await codeOf(service.mintTestCredit("dev@pid", 50000));
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: "faucet_cap_exceeded", dailyRemainingMinor: "40000" });
    expect(created).toHaveLength(0);
  });

  it("enforces the daily call budget", async () => {
    const full = Array.from({ length: 10 }, () => ({ amountIdr: 1_000n }));
    const { service, created } = setup({}, full);
    const { status, body } = await codeOf(service.mintTestCredit("dev@pid", 1000));
    expect(status).toBe(422);
    expect(body).toMatchObject({ error: "faucet_cap_exceeded" });
    expect(created).toHaveLength(0);
  });

  it("serializes the cap check inside the ledger transaction", async () => {
    const { service, prisma } = setup();
    await service.mintTestCredit("dev@pid", 10000);
    // The day-bucket read must happen inside $transaction (after the
    // per-pid lock), never as a separate pre-check — else concurrent
    // double-calls could jointly exceed the cap.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.fiatLedgerEntry.findMany).not.toHaveBeenCalled();
  });

  it("404s when the server env flag is production (route absent)", async () => {
    const { service, created } = setup({ DOKU_MODE: "production" });
    const { status } = await codeOf(service.mintTestCredit("dev@pid", 10000));
    expect(status).toBe(404);
    expect(created).toHaveLength(0);
  });

  it("refuses when the ledger is frozen", async () => {
    const { service, created } = setup({ PID_FIAT_LEDGER_FROZEN: "true" });
    await expect(service.mintTestCredit("dev@pid", 10000)).rejects.toThrow(
      expect.objectContaining({ status: 503 }),
    );
    expect(created).toHaveLength(0);
  });

  it("still mints when DOKU would be down (no provider call)", async () => {
    // checkout client is an empty stub — any DOKU corroboration attempt
    // would throw. Mint succeeds: the faucet is ledger-only by design.
    const { service, created } = setup();
    const out = await service.mintTestCredit("dev@pid", 1000);
    expect(out.amountMinor).toBe("1000");
    expect(created).toHaveLength(1);
  });
});

describe("TestCreditDto boundary passthrough", () => {
  it("lets invalid amounts reach the service (422, never pipe-400)", async () => {
    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    for (const raw of [null, 0, -5, 50001, "abc"]) {
      const out = (await pipe.transform({ amountMinor: raw }, { type: "body", metatype: TestCreditDto })) as any;
      expect(out.amountMinor).toBe(raw);
    }
    // Unknown extras are still stripped.
    const clean = (await pipe.transform({ amountMinor: 1000, env: "production" }, { type: "body", metatype: TestCreditDto })) as any;
    expect(clean).toEqual({ amountMinor: 1000 });
  });
});

describe("FaucetController production gate", () => {
  it("throws 404 before touching the ledger when DOKU_MODE=production", async () => {
    const { FaucetController } = await import("./faucet.controller");
    const ledger = { mintTestCredit: jest.fn() };
    const ctrl = new FaucetController(ledger as never, configStub({ DOKU_MODE: "production" }));
    await expect(ctrl.testCredit({ pid: "dev@pid" } as never, { amountMinor: 1000 } as never)).rejects.toThrow(
      NotFoundException,
    );
    expect(ledger.mintTestCredit).not.toHaveBeenCalled();
  });

  it("still throws UnprocessableEntityException class with status 422 (contract check)", () => {
    expect(new UnprocessableEntityException({ error: "x" }).getStatus()).toBe(422);
  });
});
