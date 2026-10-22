import { NotFoundException } from "@nestjs/common";
import { LevelsService } from "./levels.service";
import { buildThresholds, DEFAULT_FORMULA } from "./xp-curve";

const POLICY_ID = "policy-v1";
const thresholds = buildThresholds(100, DEFAULT_FORMULA).map((t) => ({
  policyVersionId: POLICY_ID,
  level: t.level,
  cumulativeXp: BigInt(t.cumulativeXp),
}));

function prismaMock() {
  return {
    xpPolicyVersion: { findFirst: jest.fn(async () => null) },
    xpLevelThreshold: { findMany: jest.fn(async () => []) },
    identity: { findUnique: jest.fn(async () => null) },
    userXpState: {
      findUnique: jest.fn(async () => null),
      findUniqueOrThrow: jest.fn(async () => null),
      create: jest.fn(async () => null),
    },
  } as any;
}

function setup() {
  const prisma = prismaMock();
  prisma.xpPolicyVersion.findFirst.mockResolvedValue({
    id: POLICY_ID,
    version: 1,
    formula: { base: 100, exponent: 1.5, rounding: "floor" },
    maxLevel: 100,
  });
  prisma.xpLevelThreshold.findMany.mockResolvedValue(thresholds);
  const service = new LevelsService(prisma as never);
  return { service, prisma };
}

describe("LevelsService", () => {
  it("getLevelView serves a live identity with exact band math", async () => {
    const { service, prisma } = setup();
    prisma.identity.findUnique.mockResolvedValue({ pid: "ifal@pid", status: "active" });
    prisma.userXpState.findUnique.mockResolvedValue({
      pid: "ifal@pid",
      totalXp: 1701n,
      level: 5,
      policyVersionId: POLICY_ID,
    });

    await expect(service.getLevelView("IFAL@pid")).resolves.toEqual({
      pid: "ifal@pid",
      level: 5,
      total_xp: 1701,
      current_level_xp: 1701,
      next_level_xp: 2819,
      progress_percentage: 0,
    });
  });

  it("lazy genesis: unknown state reads as L1/0 and creates the row", async () => {
    const { service, prisma } = setup();
    prisma.identity.findUnique.mockResolvedValue({ pid: "new@pid", status: "active" });
    prisma.userXpState.findUnique.mockResolvedValue(null);
    prisma.userXpState.create.mockResolvedValue({
      pid: "new@pid",
      totalXp: 0n,
      level: 1,
      policyVersionId: POLICY_ID,
    });

    const view = await service.getLevelView("new@pid");
    expect(view).toEqual({
      pid: "new@pid",
      level: 1,
      total_xp: 0,
      current_level_xp: 0,
      next_level_xp: 100,
      progress_percentage: 0,
    });
    expect(prisma.userXpState.create).toHaveBeenCalledWith({
      data: { pid: "new@pid", totalXp: 0n, level: 1, policyVersionId: POLICY_ID },
    });
  });

  it("404s unknown, malformed, and deleted identities (privacy)", async () => {
    const { service, prisma } = setup();
    await expect(service.getLevelView("not-a-pid")).rejects.toThrow(NotFoundException);
    prisma.identity.findUnique.mockResolvedValue(null);
    await expect(service.getLevelView("ghost@pid")).rejects.toThrow(NotFoundException);
    prisma.identity.findUnique.mockResolvedValue({ pid: "gone@pid", status: "deleted" });
    await expect(service.getLevelView("gone@pid")).rejects.toThrow(NotFoundException);
    // Suspended identities still resolve (reads are not gated on standing).
    prisma.identity.findUnique.mockResolvedValue({ pid: "sus@pid", status: "suspended" });
    prisma.userXpState.findUnique.mockResolvedValue({
      pid: "sus@pid",
      totalXp: 0n,
      level: 1,
      policyVersionId: POLICY_ID,
    });
    await expect(service.getLevelView("sus@pid")).resolves.toMatchObject({ pid: "sus@pid", level: 1 });
  });

  it("re-levels lazily when a newer policy stamped the row (R4 hook)", async () => {
    const { service, prisma } = setup();
    prisma.identity.findUnique.mockResolvedValue({ pid: "mig@pid", status: "active" });
    // Row computed under an older policy at level 1 with 100 XP; active
    // policy maps 100 XP to level 2.
    prisma.userXpState.findUnique.mockResolvedValue({
      pid: "mig@pid",
      totalXp: 100n,
      level: 1,
      policyVersionId: "policy-v0",
    });

    const view = await service.getLevelView("mig@pid");
    expect(view.level).toBe(2);
    expect(view.total_xp).toBe(100);
  });

  it("fails closed with no active policy version", async () => {
    const { service, prisma } = setup();
    prisma.xpPolicyVersion.findFirst.mockResolvedValue(null);
    prisma.identity.findUnique.mockResolvedValue({ pid: "ifal@pid", status: "active" });
    await expect(service.getLevelView("ifal@pid")).rejects.toThrow(NotFoundException);
  });
});
