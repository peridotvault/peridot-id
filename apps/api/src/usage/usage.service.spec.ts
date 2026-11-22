import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { isFirstPartyApp, UsageService, utcMonth } from "./usage.service";

/** Minimal Prisma stand-in: the unique keys ARE the idempotency mechanism, so
 *  the fake has to honour them (skipDuplicates / unique upsert). */
function setup(allowance?: string) {
  const events = new Map<string, any>();
  const monthly = new Map<string, any>();
  const apps = new Map<string, { allowedOrigins: string[] }>([
    ["pidapp_third", { allowedOrigins: ["https://game.example"] }],
    ["pidapp_other", { allowedOrigins: ["https://other.example"] }],
    ["pidapp_own", { allowedOrigins: ["https://peridot.id"] }],
  ]);
  const prisma: Record<string, any> = {
    pidApp: { findUnique: jest.fn(async ({ where }: any) => apps.get(where.clientId) ?? null) },
    usageEvent: {
      createMany: jest.fn(async ({ data }: any) => {
        let count = 0;
        for (const row of data) {
          const key = `${row.appClientId}:${row.pid}:${row.month}:${row.reason}`;
          if (events.has(key)) continue;
          events.set(key, row);
          count++;
        }
        return { count };
      }),
    },
    usageMonthly: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const key = `${where.appClientId_pid_month.appClientId}:${where.appClientId_pid_month.pid}:${where.appClientId_pid_month.month}`;
        if (monthly.has(key)) return Object.assign(monthly.get(key), update);
        monthly.set(key, create);
        return create;
      }),
      count: jest.fn(async ({ where }: any) => {
        return [...monthly.values()].filter(
          (row) =>
            row.appClientId === where.appClientId &&
            row.month === where.month &&
            (where.web3 === undefined || row.web3 === where.web3) &&
            (where.firstParty === undefined || row.firstParty === where.firstParty),
        ).length;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const values: Record<string, string> = allowance === undefined ? {} : { PID_USAGE_FREE_ALLOWANCE: allowance };
  const config = { get: (key: string, def: string) => values[key] ?? def } as unknown as ConfigService;
  const service = new UsageService(prisma as unknown as PrismaService, config);
  return { service, prisma, events, monthly };
}

describe("utcMonth", () => {
  it("uses the UTC boundary, not local time", () => {
    // 2026-03-01T00:30 in Jakarta (UTC+7) is still February in UTC.
    expect(utcMonth(new Date("2026-02-28T17:30:00Z"))).toBe("2026-02");
    expect(utcMonth(new Date("2026-02-28T23:59:59Z"))).toBe("2026-02");
    expect(utcMonth(new Date("2026-03-01T00:00:00Z"))).toBe("2026-03");
  });
});

describe("isFirstPartyApp", () => {
  const own = ["https://peridot.id", "https://dashboard.peridot.id"];
  it("exempts only apps whose origins are all first-party", () => {
    expect(isFirstPartyApp(["https://peridot.id"], own)).toBe(true);
    expect(isFirstPartyApp(["https://peridot.id/"], own)).toBe(true);
    expect(isFirstPartyApp(["https://peridot.id", "https://game.example"], own)).toBe(false);
    expect(isFirstPartyApp([], own)).toBe(false);
  });
});

describe("recordWalletLogin", () => {
  it("is idempotent: retries, a second wallet and a mixed login collapse to one PID row", async () => {
    const { service, monthly } = setup();
    await service.recordWalletLogin("pidapp_third", "ifal@pid");
    await service.recordAppLogin("pidapp_third", "ifal@pid");
    await service.recordWalletLogin("pidapp_third", "ifal@pid");
    await Promise.all([
      service.recordWalletLogin("pidapp_third", "ifal@pid"),
      service.recordAppLogin("pidapp_third", "ifal@pid"),
    ]);
    expect(monthly.size).toBe(1);
    expect(monthly.get(`pidapp_third:ifal@pid:${utcMonth()}`).web3).toBe(true);
  });

  it("counts the same PID separately in two apps", async () => {
    const { service, monthly } = setup();
    await service.recordWalletLogin("pidapp_third", "ifal@pid");
    await service.recordWalletLogin("pidapp_other", "ifal@pid");
    expect(monthly.size).toBe(2);
  });

  it("upgrades a Web2 PID to Web3 when it later proves a wallet", async () => {
    const { service, monthly } = setup();
    await service.recordAppLogin("pidapp_third", "ifal@pid");
    const key = `pidapp_third:ifal@pid:${utcMonth()}`;
    expect(monthly.get(key).web3).toBe(false);
    await service.recordWalletLogin("pidapp_third", "ifal@pid");
    expect(monthly.get(key).web3).toBe(true);
    expect(monthly.size).toBe(1);
  });

  it("stores the server-side first-party classification with the event", async () => {
    const { service, events } = setup();
    await service.recordWalletLogin("pidapp_own", "ifal@pid");
    await service.recordAppLogin("pidapp_third", "budi@pid");
    expect([...events.values()].map((row) => [row.appClientId, row.firstParty])).toEqual([
      ["pidapp_own", true],
      ["pidapp_third", false],
    ]);
  });

  it("ignores an unregistered app instead of inventing attribution", async () => {
    const { service, monthly } = setup();
    await service.recordWalletLogin("pidapp_unknown", "ifal@pid");
    await service.recordAppLogin("pidapp_unknown", "ifal@pid");
    expect(monthly.size).toBe(0);
  });

  it("never throws — metering cannot fail a completed login", async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(service.recordWalletLogin("pidapp_third", "ifal@pid")).resolves.toBeUndefined();
  });
});

describe("report", () => {
  it("reports total MAU apart from Web3 MAU, and bills only Web3", async () => {
    const { service } = setup("2");
    // three Web3 PIDs + one Web2-only PID in the same app/month.
    for (const pid of ["a@pid", "b@pid", "c@pid"]) await service.recordWalletLogin("pidapp_third", pid);
    await service.recordAppLogin("pidapp_third", "d@pid");

    expect(await service.report("pidapp_third", utcMonth())).toEqual({
      appClientId: "pidapp_third",
      month: utcMonth(),
      totalPids: 4,
      web3Pids: 3,
      firstPartyPids: 0,
      billablePids: 3,
      freeAllowance: 2,
      overagePids: 1,
      billing: "reporting-only",
    });
  });

  it("keeps Web2-only apps free: total MAU grows, Web3 MAU and overage stay 0", async () => {
    const { service } = setup("0");
    for (const pid of ["a@pid", "b@pid", "c@pid"]) await service.recordAppLogin("pidapp_third", pid);
    expect(await service.report("pidapp_third", utcMonth())).toMatchObject({
      totalPids: 3,
      web3Pids: 0,
      billablePids: 0,
      overagePids: 0,
    });
  });

  it("excludes first-party Web3 logins from the billable number", async () => {
    const { service } = setup("0");
    await service.recordWalletLogin("pidapp_own", "a@pid");
    expect(await service.report("pidapp_own", utcMonth())).toMatchObject({
      totalPids: 1,
      web3Pids: 1,
      firstPartyPids: 1,
      billablePids: 0,
      overagePids: 0,
    });
  });

  it("defaults the allowance to 500 when unset or invalid", async () => {
    expect((await setup().service.report("pidapp_third", utcMonth())).freeAllowance).toBe(500);
    expect((await setup("not-a-number").service.report("pidapp_third", utcMonth())).freeAllowance).toBe(500);
    expect((await setup("0").service.report("pidapp_third", utcMonth())).freeAllowance).toBe(0);
  });
});

describe("successful login provider attribution", () => {
  it.each([
    ["google", "oauth", "server"],
    ["phantom", "wallet_signature", "client_selected"],
    [null, null, "unknown"],
  ])("records %s with evidence %s without duplicating an exchange", async (code, protocol, evidence) => {
    const { service, prisma } = setup();
    prisma.pidApp.findUnique.mockResolvedValue({ id: "app-id" });
    prisma.loginProvider = { findUnique: jest.fn(async () => ({ protocol })) };
    prisma.loginEvent = { upsert: jest.fn(async () => ({})) };
    prisma.$executeRaw = jest.fn();
    await service.recordSuccessfulLogin("client", "a@pid", "exchange", code);
    expect(prisma.loginEvent.upsert).toHaveBeenCalledWith({
      where: { exchangeId: "exchange" }, update: {},
      create: { exchangeId: "exchange", appId: "app-id", pid: "a@pid", providerCode: code, providerEvidence: evidence },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
