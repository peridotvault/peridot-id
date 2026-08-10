import { BadRequestException, NotFoundException } from "@nestjs/common";
import { IdentityService } from "./identity.service";

function prismaMock() {
  const mocks: Record<string, unknown> = {
    identityCredential: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      delete: jest.fn(async () => ({})),
    },
    wallet: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
    },
  };
  return mocks as any;
}

function setup() {
  const prisma = prismaMock();
  const service = new IdentityService(prisma as never);
  return { service, prisma };
}

describe("IdentityService", () => {
  it("unlinkCredential deletes only the credential row and never touches the wallet", async () => {
    const { service, prisma } = setup();
    prisma.identityCredential.findFirst.mockResolvedValue({ id: "cred-1" });
    prisma.identityCredential.count.mockResolvedValue(2);

    await service.unlinkCredential("pid_01HASH", "cred-1");

    expect(prisma.identityCredential.delete).toHaveBeenCalledWith({ where: { id: "cred-1" } });
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.wallet.create).not.toHaveBeenCalled();
  });

  it("unlinkCredential rejects when it would remove the last credential", async () => {
    const { service, prisma } = setup();
    prisma.identityCredential.findFirst.mockResolvedValue({ id: "cred-1" });
    prisma.identityCredential.count.mockResolvedValue(1);

    await expect(service.unlinkCredential("pid_01HASH", "cred-1")).rejects.toThrow(BadRequestException);
    expect(prisma.identityCredential.delete).not.toHaveBeenCalled();
  });

  it("unlinkCredential rejects an unknown credential", async () => {
    const { service, prisma } = setup();

    await expect(service.unlinkCredential("pid_01HASH", "cred-missing")).rejects.toThrow(NotFoundException);
    expect(prisma.identityCredential.delete).not.toHaveBeenCalled();
  });

  it("unlink-then-relogin: removing Google (with another credential present) keeps the wallet (PRD §3)", async () => {
    const creds = new Map([
      ["cred-google", { id: "cred-google", identityId: "pid_01HASH", provider: "google" }],
      ["cred-other", { id: "cred-other", identityId: "pid_01HASH", provider: "discord" }],
    ]);
    const wallets = new Map([
      ["pid_01HASH", { id: "wallet-1", chain: "solana", address: "addr-1", status: "active" }],
    ]);
    const prisma = {
      identityCredential: {
        findFirst: jest.fn(async ({ where }: { where: { id: string; identityId: string } }) =>
          [...creds.values()].find((c) => c.id === where.id && c.identityId === where.identityId) ?? null,
        ),
        count: jest.fn(async ({ where }: { where: { identityId: string } }) =>
          [...creds.values()].filter((c) => c.identityId === where.identityId).length,
        ),
        delete: jest.fn(async ({ where }: { where: { id: string } }) => {
          creds.delete(where.id);
          return { id: where.id };
        }),
      },
      wallet: {
        findUnique: jest.fn(async ({ where }: { where: { identityId: string } }) => wallets.get(where.identityId) ?? null),
        create: jest.fn(async () => ({})),
      },
    };
    const service = new IdentityService(prisma as never);

    await service.unlinkCredential("pid_01HASH", "cred-google");

    expect(creds.has("cred-google")).toBe(false);
    expect(creds.has("cred-other")).toBe(true);
    expect(await prisma.wallet.findUnique({ where: { identityId: "pid_01HASH" } })).toEqual({
      id: "wallet-1",
      chain: "solana",
      address: "addr-1",
      status: "active",
    });
  });
});
