import { NotFoundException } from "@nestjs/common";
import { AccountService } from "./account.service";
import { mockSecurity, minimalChainsStub } from "../../test/factories";

const PROGRAM_ID = "9LCZEdXdmLeEyU8Fik2721R28K4xWXTrVd76r4tczNZY";
const DERIVED = "2XSyY7tMgbwfsHx7pkqYjwcpyoFLtFwzSophsFFtuaHj"; // PDA of ifal@pid (see smart-account.spec.ts)

const SMART = "smart_account";

function chainRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "chain-1",
    pid: "pid_01HASH",
    chainId: "chain-sol",
    chain: { namespace: "solana", reference: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z" },
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
  const security = mockSecurity();
  const prisma = {
    chainAccount: {
      findFirst: jest.fn(async () => null as any),
      findMany: jest.fn(async () => [] as any),
      create: jest.fn(async () => chainRow()),
      update: jest.fn(async () => chainRow()),
    },
    securityEvent: { create: jest.fn(async () => ({})) },
  };
  const chains = minimalChainsStub();
  const service = new AccountService(prisma as never, config as never, security as never, chains as never);
  return { service, prisma, config, security, chains };
}

describe("AccountService", () => {
  it("ensureAccount seeds the smart_account with the derived PDA address", async () => {
    const { service, prisma, security } = setup();
    prisma.chainAccount.findFirst.mockResolvedValueOnce(null); // smart row missing
    prisma.chainAccount.findMany.mockResolvedValue([chainRow()]);

    const views = await service.ensureAccount("ifal@pid");

    expect(prisma.chainAccount.create).toHaveBeenCalledWith({
      data: {
        pid: "ifal@pid",
        chainId: "chain-sol",
        address: DERIVED,
        accountType: SMART,
      },
    });
    expect(security.log).toHaveBeenCalledWith("ifal@pid", "account.created", {});
    expect(views[0].address).toBe(DERIVED);
  });

  it("ensureAccount does not reseed the smart row when it already exists", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findFirst.mockResolvedValue(chainRow());
    prisma.chainAccount.findMany.mockResolvedValue([chainRow()]);

    await service.ensureAccount("pid_01HASH");

    expect(prisma.chainAccount.create).not.toHaveBeenCalled();
  });

  it("ensureAccount seeds one identical EVM address per chain when the factory is configured", async () => {
    const { deriveEvmSmartAccountAddress } = jest.requireActual("@peridotvault/pid-evm") as typeof import("@peridotvault/pid-evm");
    const factory = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
    const impl = "0x0000000000000000000000000000000000000001";
    const config = {
      getOrThrow: jest.fn(() => PROGRAM_ID),
      get: jest.fn(() => undefined),
    };
    const chains = {
      solanaChainIdOrThrow: jest.fn(async () => "chain-sol"),
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
    const security = mockSecurity();
    const prisma = {
      chainAccount: {
        findFirst: jest.fn(async () => null as any),
        findMany: jest.fn(async () => [chainRow()] as any),
        create: jest.fn(async (args: { data: { address: string } }) => ({ id: "c", ...args.data })),
        update: jest.fn(async () => ({})),
      },
      securityEvent: { create: jest.fn(async () => ({})) },
    };
    const service = new AccountService(prisma as never, config as never, security as never, chains as never);

    await service.ensureAccount("pid_01HASH");

    const expected = deriveEvmSmartAccountAddress("pid_01HASH", factory, impl).address;
    const creates = prisma.chainAccount.create.mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);
    const evmCreates = creates.filter((d) => d.chainId !== "chain-sol");
    // One row per phase-1 chain, all the same counterfactual address.
    expect(evmCreates.map((d) => d.chainId).sort()).toEqual(["chain-10143", "chain-421614", "chain-84532", "chain-97"]);
    for (const row of evmCreates) expect(row.address).toBe(expected);
  });

  it("ensureAccount fails cleanly when the solana chain is not registered", async () => {
    const { service, prisma, chains } = setup();
    (chains.solanaChainIdOrThrow as jest.Mock).mockRejectedValue(new NotFoundException("Solana chain is not registered — run db:seed"));

    await expect(service.ensureAccount("pid_01HASH")).rejects.toThrow(NotFoundException);
    await expect(service.ensureAccount("pid_01HASH")).rejects.toThrow("run db:seed");
    expect(prisma.chainAccount.create).not.toHaveBeenCalled();
  });

  it("getChains throws NotFound when the PID has no wallet yet", async () => {
    const { service } = setup();

    await expect(service.getChains("pid_OTHER")).rejects.toThrow(NotFoundException);
  });

  it("getChains maps the wallet's chain rows", async () => {
    const { service, prisma } = setup();
    prisma.chainAccount.findMany.mockResolvedValue([chainRow()]);

    const views = await service.getChains("pid_01HASH");

    expect(views).toHaveLength(1);
    expect(views[0].accountType).toBe(SMART);
  });
});
