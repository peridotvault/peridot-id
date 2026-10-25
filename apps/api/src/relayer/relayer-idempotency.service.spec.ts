// H2 idempotency vectors (ANT-575 FR-H.2): at-most-once broadcast per
// (pid, nonce, chain), identical-bytes rebroadcast bound, DIFFERENT-bytes
// rejection, and resolve-then-act outcomes (H-AC3, H-AC7).
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { RelayerIdempotencyService } from "./relayer-idempotency.service";
import { mockSecurity } from "../../test/factories";

const PID = "pid_01HASH";

/** In-memory RelayerBroadcast delegate keyed by pid|nonce|chain. */
function mockPrisma() {
  const rows = new Map<string, { pid: string; nonce: string; chain: string; txBytesHash: string; signature: string | null; status: string }>();
  const key = (pid: string, nonce: string, chain: string) => `${pid}|${nonce}|${chain}`;
  return {
    rows,
    relayerBroadcast: {
      findUnique: jest.fn(async ({ where }: { where: { pid_nonce_chain: { pid: string; nonce: string; chain: string } } }) => {
        const k = where.pid_nonce_chain;
        return rows.get(key(k.pid, k.nonce, k.chain)) ?? null;
      }),
      findFirst: jest.fn(async ({ where }: { where: { pid: string; chain: string; entryPoint: string; status: { in: string[] } } }) => {
        for (const r of rows.values()) {
          if (r.pid === where.pid && where.status.in.includes(r.status)) return r;
        }
        return null;
      }),
      create: jest.fn(async ({ data }: { data: { pid: string; nonce: string; chain: string; entryPoint: string; txBytesHash: string; status: string } }) => {
        const row = { ...data, signature: null as string | null };
        rows.set(key(data.pid, data.nonce, data.chain), row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { pid_nonce_chain: { pid: string; nonce: string; chain: string } }; data: { signature?: string; status?: string } }) => {
        const k = where.pid_nonce_chain;
        const row = rows.get(key(k.pid, k.nonce, k.chain));
        if (!row) throw new Error("row not found");
        Object.assign(row, data);
        return row;
      }),
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
    await service.recordSubmission(PID, "7", "solana", "sig-1");
    await service.recordOutcome(PID, "7", "solana", "confirmed", "sig-1");
    const row = prisma.rows.get(`${PID}|7|solana`);
    expect(row?.status).toBe("confirmed");
    expect(row?.signature).toBe("sig-1");
  });

  it("dedupes an identical-bytes retry without a new broadcast (H-AC3)", async () => {
    const { service, security } = setup();
    await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    await service.recordSubmission(PID, "7", "solana", "sig-1");
    const retry = await service.claimSlot(PID, "7", "solana", "hash-a", "withdraw");
    expect(retry).toEqual({ decision: "duplicate", signature: "sig-1" });
    expect(security.log).toHaveBeenCalledWith(PID, "broadcast.duplicate_suppressed", expect.objectContaining({ signature: "sig-1" }));
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
    await service.recordSubmission(PID, "4", "solana", "sig-r");
    await expect(service.assertNoInflightRotation(PID, "solana")).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(security.log).toHaveBeenCalledWith(
      PID,
      "credential.rotation.unconfirmed",
      expect.objectContaining({ guard: "double-rotation" }),
    );
    // Confirmed rotations no longer block.
    await service.recordOutcome(PID, "4", "solana", "confirmed", "sig-r");
    await expect(service.assertNoInflightRotation(PID, "solana")).resolves.toBeUndefined();
  });
});
