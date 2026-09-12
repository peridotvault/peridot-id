import { NotFoundException } from "@nestjs/common";
import { AccountService } from "./account.service";

const PROGRAM_ID = "9LCZEdXdmLeEyU8Fik2721R28K4xWXTrVd76r4tczNZY";
const ACCOUNT_ID = "b3f1e6a9-2c4d-4f8b-9a3e-8d7c5b2a1f9e";
const DERIVED = "E51nPEyN8TFAXQSxQoZBGgRG9XvLRA37d4ZMobA19cs"; // reference vector (seed = peridot_id)

const SMART = "smart_account";

function accountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ACCOUNT_ID,
    identityId: "pid_01HASH",
    status: "active",
    version: 1,
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
    updatedAt: new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  };
}

function chainRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "chain-1",
    accountId: ACCOUNT_ID,
    chainNamespace: "solana",
    chainReference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
    address: DERIVED,
    accountType: SMART,
    status: "active",
    createdAt: new Date("2026-08-10T12:00:00.000Z"),
    updatedAt: new Date("2026-08-10T12:00:00.000Z"),
    ...overrides,
  };
}

function setup() {
  const config = { getOrThrow: jest.fn(() => PROGRAM_ID) };
  const security = { log: jest.fn(async () => undefined) };
  const prisma = {
    pidAccount: {
      findFirst: jest.fn(async () => null as any),
      findMany: jest.fn(async () => [] as any),
      create: jest.fn(async () => accountRow()),
    },
    chainAccount: {
      findFirst: jest.fn(async () => null as any),
      create: jest.fn(async () => chainRow()),
    },
    securityEvent: { create: jest.fn(async () => ({})) },
  };
  const chains = {
    activeChains: jest.fn(async () => []),
    deployableEvmChains: jest.fn(async () => []),
    deploymentFor: jest.fn(async () => null),
    chainByReference: jest.fn(async () => undefined),
    rpcUrlForReference: jest.fn(async () => "http://localhost:8545"),
    invalidate: jest.fn(),
  };
  const service = new AccountService(prisma as never, config as never, security as never, chains as never);
  return { service, prisma, config, security };
}

describe("AccountService", () => {
  it("createAccount seeds the smart_account with the derived PDA address", async () => {
    const { service, prisma, security } = setup();
    prisma.pidAccount.findFirst
      .mockResolvedValueOnce(null) // initial existence check
      .mockResolvedValueOnce(accountRow({ chainAccounts: [chainRow()] })); // getAccount

    const view = await service.createAccount("pid_01HASH");

    expect(prisma.pidAccount.create).toHaveBeenCalledWith({ data: { identityId: "pid_01HASH" } });
    expect(prisma.chainAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          accountId: ACCOUNT_ID,
          chainNamespace: "solana",
          chainReference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
          address: DERIVED,
          accountType: SMART,
        },
      }),
    );
    expect(security.log).toHaveBeenCalledWith("pid_01HASH", "account.created", {}, ACCOUNT_ID);
    expect(view.id).toBe(ACCOUNT_ID);
    expect(view.chainAccounts[0].address).toBe(DERIVED);
  });

  it("createAccount returns the existing account instead of creating a duplicate", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst
      .mockResolvedValueOnce(accountRow()) // initial check
      .mockResolvedValueOnce(accountRow({ chainAccounts: [chainRow()] })); // getAccount
    prisma.chainAccount.findFirst.mockResolvedValue(chainRow()); // smart row already exists

    const view = await service.createAccount("pid_01HASH");

    expect(prisma.pidAccount.create).not.toHaveBeenCalled();
    expect(prisma.chainAccount.create).not.toHaveBeenCalled();
    expect(view.chainAccounts[0].address).toBe(DERIVED);
  });

  it("createAccount does not reseed the smart row when it already exists", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(accountRow({ chainAccounts: [chainRow()] }));
    prisma.chainAccount.findFirst.mockResolvedValue(chainRow());

    await service.createAccount("pid_01HASH");

    expect(prisma.chainAccount.create).not.toHaveBeenCalled();
  });

  it("createAccount seeds one identical EVM address per chain when the factory is configured", async () => {
    const { deriveEvmSmartAccountAddress } = jest.requireActual("@peridotvault/pid-evm") as typeof import("@peridotvault/pid-evm");
    const factory = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
    const impl = "0x0000000000000000000000000000000000000001";
    const config = {
      getOrThrow: jest.fn(() => PROGRAM_ID),
      get: jest.fn(() => undefined),
    };
    const chains = {
      deployableEvmChains: jest.fn(async () =>
        ["10143", "97", "421614", "84532"].map((reference) => ({
          id: `chain-${reference}`,
          namespace: "eip155",
          reference,
          name: `chain-${reference}`,
          nativeSymbol: "T",
          decimals: 18,
          rpcUrls: [],
          explorerUrl: null,
          logoUrl: null,
          isTestnet: true,
          contracts: [
            { type: "factory", address: factory, versionLabel: "v1" },
            { type: "account_implementation", address: impl, versionLabel: "v1" },
          ],
        })),
      ),
    };
    const security = { log: jest.fn(async () => undefined) };
    const prisma = {
      pidAccount: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null as any)
          .mockResolvedValueOnce(accountRow({ chainAccounts: [chainRow()] })),
        findMany: jest.fn(async () => [] as any),
        create: jest.fn(async () => accountRow()),
      },
      chainAccount: {
        findFirst: jest.fn(async () => null as any),
        create: jest.fn(async (args: { data: { address: string } }) => ({ id: "c", ...args.data })),
        update: jest.fn(async () => ({})),
      },
      securityEvent: { create: jest.fn(async () => ({})) },
    };
    const service = new AccountService(prisma as never, config as never, security as never, chains as never);

    await service.createAccount("pid_01HASH");

    const expected = deriveEvmSmartAccountAddress(ACCOUNT_ID, factory, impl).address;
    const creates = prisma.chainAccount.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    const evmCreates = creates.filter((d) => d.chainNamespace === "eip155");
    // One row per phase-1 chain, all the same counterfactual address.
    expect(evmCreates.map((d) => d.chainReference).sort()).toEqual(["10143", "421614", "84532", "97"]);
    for (const row of evmCreates) expect(row.address).toBe(expected);
  });

  it("getAccount throws NotFound for an account that is not the PID's own", async () => {
    const { service } = setup();

    await expect(service.getAccount("pid_OTHER", ACCOUNT_ID)).rejects.toThrow(NotFoundException);
  });

  it("getAccountChains throws NotFound for another PID's account", async () => {
    const { service } = setup();

    await expect(service.getAccountChains("pid_OTHER", ACCOUNT_ID)).rejects.toThrow(NotFoundException);
  });

  it("getAccounts maps active accounts with their chain accounts", async () => {
    const { service, prisma } = setup();
    prisma.pidAccount.findMany.mockResolvedValue([accountRow({ chainAccounts: [chainRow()] })]);

    const views = await service.getAccounts("pid_01HASH");

    expect(views).toHaveLength(1);
    expect(views[0].chainAccounts[0].accountType).toBe(SMART);
  });
});