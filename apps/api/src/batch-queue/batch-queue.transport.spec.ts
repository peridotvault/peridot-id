// Production transport specs (ANT-767 scope expansion): the production
// BatchPorts factory fails closed when operator inputs are unset (no relayer
// row, unreachable RPC) and never touches the network in these tests.
// Live-chain behavior is covered by code review + the submitter path's
// reuse of the evm-activation single-call precedent.
import { productionBatchPorts } from "./batch-queue.transport";

const ACCOUNT = "0x15b4f164718fac7cfda7b60687aca4173c99aafc";
const TARGET_A = "0x2222222222222222222222222222222222222222";
const GAME_DATA = "0x123456780000000000000000000000000000000000000000000000000000000000000001";

const envelope = (): Record<string, unknown> => ({
  version: 1,
  kind: "owner-execute-v3",
  account: ACCOUNT,
  chainId: "10143",
  call: { to: TARGET_A, value: "0", data: GAME_DATA },
  auth: {
    deadline: 2000000000,
    feePolicyVersion: 2,
    authenticatorData: "0x0404",
    clientDataJSON: "0x7b7d",
    r: "0x0606060606060606060606060606060606060606060606060606060606060606",
    s: "0x0707070707070707070707070707070707070707070707070707070707070707",
  },
});

const op = () => ({ to: TARGET_A, value: "0", data: GAME_DATA, intent: envelope() });

function harness(opts: { relayer: string | null; rpcUrl?: string }) {
  const chains = {
    rpcUrlForReference: jest.fn(async () => opts.rpcUrl ?? "http://127.0.0.1:9"),
    relayerSecretFor: jest.fn(async () => opts.relayer),
    chainByReference: jest.fn(async () => undefined),
  };
  const config = { get: jest.fn(() => undefined) };
  const ports = productionBatchPorts(chains as never, config as never);
  return { ports, chains };
}

describe("productionBatchPorts fail-closed (unprovisioned operator inputs)", () => {
  it("estimator 503s without a relayer row", async () => {
    const { ports } = harness({ relayer: null });
    await expect(ports.estimator.estimateNetworkCost(op() as never)).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining("not configured") }),
    );
  });

  it("simulator 503s without a relayer row (loud, never a silent failed batch)", async () => {
    const { ports } = harness({ relayer: null });
    await expect(ports.simulator.simulate(op() as never)).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining("not configured") }),
    );
  });

  it("submitter 503s without a relayer row", async () => {
    const { ports } = harness({ relayer: null });
    await expect(ports.submitter.submit(op() as never)).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining("not configured") }),
    );
  });

  it("rejects malformed relayer secrets without touching the network", async () => {
    const { ports, chains } = harness({ relayer: "plaintext-not-a-key" });
    await expect(ports.estimator.estimateNetworkCost(op() as never)).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining("not configured") }),
    );
    // No RPC call was attempted: the secret check fails first.
    expect(chains.rpcUrlForReference).not.toHaveBeenCalled();
  });

  it("sessions.check fails closed to revoked without a grant reference", async () => {
    const { ports } = harness({ relayer: null });
    await expect(
      ports.sessions.check({ keyAddress: "0x5555555555555555555555555555555555555555", sequence: 7, nowSec: 1000 }),
    ).resolves.toEqual({ valid: false, revoked: true, expiresAt: 0 });
  });

  describe("sessions.check on-chain grant pre-flight (mocked eth_call)", () => {
    const PERMISSION_ID = "0x0707070707070707070707070707070707070707070707070707070707070707";
    const word = (n: bigint): string => n.toString(16).padStart(64, "0");
    const grantHex = (seq: number, validAfter = 1, validUntil = 9999999999, revoked = 0): string => {
      const words = [
        word(0n), word(0n), // sessionX, sessionY
        word(BigInt(validAfter)), word(BigInt(validUntil)), word(BigInt(seq)),
        word(1n), // kind
        word(BigInt(revoked)),
        ...Array.from({ length: 12 }, () => word(0n)), // target..feeSpent
      ];
      return `0x${words.join("")}`;
    };

    let realFetch: typeof fetch;
    beforeEach(() => { realFetch = global.fetch; });
    afterEach(() => { global.fetch = realFetch; });
    const mockGrant = (hex: string) => {
      global.fetch = jest.fn(async () =>
        ({ ok: true, json: async () => ({ result: hex }) }) as never,
      ) as never;
    };

    it("returns valid for a live grant with matching seq", async () => {
      const { ports } = harness({ relayer: "0x0000000000000000000000000000000000000000000000000000000000000001" });
      mockGrant(grantHex(7));
      await expect(
        ports.sessions.check({ keyAddress: "0x5555555555555555555555555555555555555555", sequence: 7, nowSec: 1000, account: ACCOUNT, permissionId: PERMISSION_ID }),
      ).resolves.toEqual({ valid: true, revoked: false, expiresAt: 9999999999 });
    });

    it("fails closed to revoked when the on-chain seq advanced past the envelope seq", async () => {
      const { ports } = harness({ relayer: "0x0000000000000000000000000000000000000000000000000000000000000001" });
      mockGrant(grantHex(8)); // grant already spent once more than this intent
      await expect(
        ports.sessions.check({ keyAddress: "0x5555555555555555555555555555555555555555", sequence: 7, nowSec: 1000, account: ACCOUNT, permissionId: PERMISSION_ID }),
      ).resolves.toMatchObject({ valid: false, revoked: true });
    });

    it("fails closed to revoked for an all-zero (nonexistent) grant", async () => {
      const { ports } = harness({ relayer: "0x0000000000000000000000000000000000000000000000000000000000000001" });
      mockGrant(`0x${"00".repeat(19 * 32)}`);
      await expect(
        ports.sessions.check({ keyAddress: "0x5555555555555555555555555555555555555555", sequence: 7, nowSec: 1000, account: ACCOUNT, permissionId: PERMISSION_ID }),
      ).resolves.toEqual({ valid: false, revoked: true, expiresAt: 0 });
    });
  });

  it("sessions.check throws (never settles blind) when the chain is unreachable", async () => {
    const { ports } = harness({
      relayer: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });
    await expect(
      ports.sessions.check({
        keyAddress: "0x5555555555555555555555555555555555555555",
        sequence: 7,
        nowSec: 1000,
        account: ACCOUNT,
        permissionId: "0x0707070707070707070707070707070707070707070707070707070707070707",
      }),
    ).rejects.toThrow(expect.objectContaining({ message: expect.stringContaining("not reachable") }));
  });
});
