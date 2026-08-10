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
});
