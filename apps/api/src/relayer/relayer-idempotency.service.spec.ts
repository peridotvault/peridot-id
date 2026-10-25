// H2 idempotency vectors (ANT-575 FR-H.2): at-most-once broadcast per
// (pid, nonce, chain), identical-bytes rebroadcast bound, DIFFERENT-bytes
// rejection, and resolve-then-act outcomes (H-AC3, H-AC7).
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { RelayerIdempotencyService } from "./relayer-idempotency.service";
import { mockSecurity } from "../../test/factories";

const PID = "pid_01HASH";

/** In-memory RelayerBroadcast delegate keyed by pid|nonce|chain. */
function mockPrisma() {
  const rows = new Map<string, { pid: string; nonce: string; chain: string; txBytesHash: string; signature: string | null; status: string; updatedAt: Date }>();
  const key = (pid: string, nonce: string, chain: string, entryPoint = "withdraw") =>
    `${pid}|${nonce}|${chain}|${entryPoint}`;
  return {
    rows,
    relayerBroadcast: {
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { pid_nonce_chain_entryPoint: { pid: string; nonce: string; chain: string; entryPoint: string } };
        }) => {
          const k = where.pid_nonce_chain_entryPoint;
          return rows.get(key(k.pid, k.nonce, k.chain, k.entryPoint)) ?? null;
        },
      ),
      findFirst: jest.fn(async ({ where }: { where: { pid: string; chain: string; entryPoint: string; status: { in: string[] } } }) => {
        for (const r of rows.values()) {
          if (r.pid === where.pid && where.status.in.includes(r.status)) return r;
        }
        return null;
      }),
      create: jest.fn(async ({ data }: { data: { pid: string; nonce: string; chain: string; entryPoint: string; txBytesHash: string; status: string } }) => {
        const row = { ...data, signature: null as string | null, updatedAt: new Date() };
        rows.set(key(data.pid, data.nonce, data.chain, data.entryPoint), row);
        return row;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { pid_nonce_chain_entryPoint: { pid: string; nonce: string; chain: string; entryPoint: string } };
          data: { signature?: string; status?: string };
        }) => {
          const k = where.pid_nonce_chain_entryPoint;
          const row = rows.get(key(k.pid, k.nonce, k.chain, k.entryPoint));
          if (!row) throw new Error("row not found");
          Object.assign(row, data);
          return row;
        },
      ),
    },
  };
}

function setup() {
  const prisma = mockPrisma();
  const security = mockSecurity();
  const service = new RelayerIdempotencyService(prisma as never, security as never);
  return { service, prisma, security };
}

describe("RelayerIdempotencyService", () => {
  it("claims a fresh slot and confirms it (H-AC3: at-most-once)", async () => {
    const { service, prisma } = setup();
    const claim = await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    expect(claim).toEqual({ decision: "proceed", signature: null });
    await service.recordSubmission(PID, "7", "solana", "withdraw", "sig-1");
    await service.recordOutcome(PID, "7", "solana", "withdraw", "confirmed", "sig-1");
    const row = prisma.rows.get(`${PID}|7|solana|withdraw`);
    expect(row?.status).toBe("confirmed");
    expect(row?.signature).toBe("sig-1");
  });

  it("dedupes an identical-bytes retry without a new broadcast (H-AC3)", async () => {
    const { service, security } = setup();
    await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    await service.recordSubmission(PID, "7", "solana", "withdraw", "sig-1");
    const retry = await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    expect(retry).toEqual({ decision: "duplicate", signature: "sig-1" });
    expect(security.log).toHaveBeenCalledWith(PID, "broadcast.duplicate_suppressed", expect.objectContaining({ signature: "sig-1" }));
  });

  it("serializes concurrent identical claims via the unique index (F2)", async () => {
    const { service, prisma } = setup();
    await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    // A racing claim that passed findUnique before the row existed: create
    // hits the unique index; the service re-reads instead of 500ing.
    prisma.relayerBroadcast.findUnique.mockResolvedValueOnce(null);
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "test",
    });
    prisma.relayerBroadcast.create.mockRejectedValueOnce(p2002);
    const retry = await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    expect(retry.decision).toBe("duplicate");
  });

  it("isolates slots by entry point so a failed withdraw never bricks execute (F4)", async () => {
    const { service } = setup();
    await service.claimSlot(PID, "7", "solana", "hash-w", "withdraw");
    await service.recordSubmission(PID, "7", "solana", "withdraw", "sig-w");
    await service.recordOutcome(PID, "7", "solana", "withdraw", "failed", "sig-w");
    // Same nonce, different entry point: proceeds (the chain nonce still
    // guards on-chain execution; the ledger only serializes same-entry retries).
    const claim = await service.claimSlot(PID, "7", "solana", "hash-e", "execute");
    expect(claim).toEqual({ decision: "proceed", signature: null });
    // Same entry point, different bytes: still forbidden.
    await expect(service.claimSlot(PID, "7", "solana", "hash-w2", "withdraw")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("FORBIDS different bytes under the same nonce (H2.v)", async () => {
    const { service, security } = setup();
    await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    await expect(service.claimSlot(PID, "7", "solana", "hash-B-DIFFERENT", "withdraw")).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "broadcast.conflicting_bytes_rejected",
      expect.objectContaining({ nonce: "7" }),
    );
  });

  it("rebroadcasts identical bytes ONLY on proven non-landing (H-AC7 not-landed)", async () => {
    const { service, security } = setup();
    await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    const broadcast = jest
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed: socket hang up"))
      .mockResolvedValueOnce({ signature: "sig-2", result: null });
    const out = await service.broadcastWithResolveThenAct({
      pid: PID,
      nonce: "7",
      chain: "solana",
      entryPoint: "withdraw",
      broadcast,
      resolveState: async () => ({ landed: false as const }),
    });
    expect(out).toEqual({ signature: "sig-2", result: null, outcome: "resolved-not-landed-rebroadcast" });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "broadcast.resolved_not_landed_rebroadcast",
      expect.objectContaining({ nonce: "7" }),
    );
  });

  it("never rebroadcasts on proven landing (H-AC7 landed)", async () => {
    const { service, security } = setup();
    await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    const broadcast = jest.fn().mockRejectedValueOnce(new Error("timeout of 1000ms exceeded"));
    const out = await service.broadcastWithResolveThenAct({
      pid: PID,
      nonce: "7",
      chain: "solana",
      entryPoint: "withdraw",
      broadcast,
      resolveState: async () => ({ landed: true as const, signature: "sig-1" }),
    });
    expect(out).toEqual({ signature: "sig-1", result: null, outcome: "resolved-landed" });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "broadcast.resolved_landed",
      expect.objectContaining({ signature: "sig-1" }),
    );
  });

  it("parks + alerts when chain state is unreadable (H-AC7 unreadable)", async () => {
    const { service, security } = setup();
    await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    const broadcast = jest.fn().mockRejectedValueOnce(new Error("fetch failed"));
    await expect(
      service.broadcastWithResolveThenAct({
        pid: PID,
        nonce: "7",
        chain: "solana",
        entryPoint: "withdraw",
        broadcast,
        resolveState: async () => ({ unreadable: true as const }),
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "broadcast.parked_unreadable",
      expect.objectContaining({ nonce: "7" }),
    );
    expect(security.log).toHaveBeenCalledWith(PID, "relayer.parked", expect.objectContaining({ chain: "solana" }));
  });

  it("exhausts the resolve bound then parks (R-NFR-11)", async () => {
    jest.useFakeTimers();
    try {
      const { service } = setup();
      await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
      const broadcast = jest.fn().mockRejectedValue(new Error("socket hang up"));
      const pending = service.broadcastWithResolveThenAct({
        pid: PID,
        nonce: "7",
        chain: "solana",
        entryPoint: "withdraw",
        broadcast,
        resolveState: async (): Promise<never> => {
          throw new Error("rpc down");
        },
      });
      const assertion = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
      await jest.runAllTimersAsync();
      await assertion;
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("rethrows deterministic failures without resolving", async () => {
    const { service, security } = setup();
    const resolveState = jest.fn();
    await expect(
      service.broadcastWithResolveThenAct({
        pid: PID,
        nonce: "7",
        chain: "solana",
        entryPoint: "withdraw",
        broadcast: async () => {
          throw new Error("transaction reverted: custom 0x1");
        },
        resolveState,
      }),
    ).rejects.toThrow("transaction reverted");
    expect(resolveState).not.toHaveBeenCalled();
    expect(security.log).not.toHaveBeenCalled();
  });

  it("guards double rotation while one may still confirm (H2.iv)", async () => {
    const { service, security } = setup();
    await service.claimSlot(PID, "4", "solana", "hash-r", "rotate");
    await service.recordSubmission(PID, "4", "solana", "rotate", "sig-r");
    await expect(service.assertNoInflightRotation(PID, "solana", 4n)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "credential.rotation.unconfirmed",
      expect.objectContaining({ guard: "double-rotation" }),
    );
    // Confirmed rotations no longer block.
    await service.recordOutcome(PID, "4", "solana", "rotate", "confirmed", "sig-r");
    await expect(service.assertNoInflightRotation(PID, "solana", 4n)).resolves.toBeUndefined();
  });

  it("releases a stale-nonce slot as expired instead of bricking (F1)", async () => {
    const { service, security, prisma } = setup();
    await service.claimSlot(PID, "4", "solana", "hash-r", "rotate");
    await service.recordSubmission(PID, "4", "solana", "rotate", "sig-r");
    // Chain moved past the slot's nonce: the slot can never land.
    await expect(service.assertNoInflightRotation(PID, "solana", 5n)).resolves.toBeUndefined();
    expect(prisma.rows.get(`${PID}|4|solana|rotate`)?.status).toBe("expired");
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "credential.rotation.unconfirmed",
      expect.objectContaining({ guard: "stale-slot-released" }),
    );
  });

  it("releases an aged slot as expired (F1)", async () => {
    const { service, prisma } = setup();
    await service.claimSlot(PID, "4", "solana", "hash-r", "rotate");
    await service.recordSubmission(PID, "4", "solana", "rotate", "sig-r");
    prisma.rows.get(`${PID}|4|solana|rotate`)!.updatedAt = new Date(Date.now() - 20 * 60 * 1000);
    await expect(service.assertNoInflightRotation(PID, "solana", 4n)).resolves.toBeUndefined();
    expect(prisma.rows.get(`${PID}|4|solana|rotate`)?.status).toBe("expired");
  });
});
