// Shared Jest doubles for API specs. Only hosts fixtures that are byte-identical
// across files — tailored mocks (stateful route-test Maps, session/device stores,
// per-file row factories with file-specific ids/addresses) stay per-file;
// merging those costs more than it saves.
export const TEST_PID = "pid_01HASH";

/** No-op security-event logger double (9 spec files, verbatim). */
export function mockSecurity() {
  return { log: jest.fn(async () => undefined) };
}

/**
 * Relayer H2 idempotency double: pass-through slot claim (first-claim
 * proceeds) + direct broadcast (no resolve path). Specs covering
 * resolve-then-act override `broadcastWithResolveThenAct` per test.
 */
export function mockIdempotency() {
  return {
    claimSlot: jest.fn(async () => ({ decision: "proceed", signature: null })),
    recordSubmission: jest.fn(async () => undefined),
    recordOutcome: jest.fn(async () => undefined),
    assertNoInflightRotation: jest.fn(async () => undefined),
    broadcastWithResolveThenAct: jest.fn(
      async (opts: { broadcast: () => Promise<{ signature: string; result: null }> }) => {
        const out = await opts.broadcast();
        return { signature: out.signature, result: out.result, outcome: "broadcast-ok" as const };
      },
    ),
  };
}

/** Relayer H1.i revocation-spike double: records without ever paging. */
export function mockRevocations() {
  return { recordRevocation: jest.fn(async () => ({ spike: false })) };
}

/** Relayer H3 breaker double: closed breaker, recording absorbed without opening. */
export function mockBreaker() {
  return {
    requireClosed: jest.fn(async () => undefined),
    recordAbsorbed: jest.fn(async () => ({ open: false })),
    isOpen: jest.fn(() => false),
    closeBreaker: jest.fn(async () => undefined),
    snapshot: jest.fn(() => ({ open: false })),
    withBoundedRetries: jest.fn(
      async (
        _pid: string,
        _chain: string,
        _entry: string,
        _op: string,
        fn: () => Promise<unknown>,
      ) => fn(),
    ),
  };
}

/**
 * Solana relayer config stub (activation + sponsored withdraw). Per-file extras
 * (e.g. confirm attempts) pass via `extra`; unknown keys throw like the real one.
 */
export function solanaRelayerConfig(extra: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    PID_SOLANA_RPC_URL: "https://api.devnet.solana.com",
    PID_ACTIVATION_MARGIN_RATE: "0.5",
    ...extra,
  };
  return {
    get: jest.fn((key: string, def?: unknown) => values[key] ?? def),
    getOrThrow: jest.fn((key: string) => {
      if (key === "PID_RELAYER_SECRET") return "11".repeat(32);
      if (key === "PID_TREASURY_PUBKEY") return TREASURY;
      throw new Error(`Missing config: ${key}`);
    }),
  };
}

export const TREASURY = "3KKrsVy9Xc5QdnxnekmZpLM5wqCarrraBm1zGFTeDL5W";
export const RELAYER = TREASURY;

// Valid ES256 COSE_Key (map(5), matches real simplewebauthn output). Shared by
// specs that use the key opaquely (verification is mocked); specs asserting on
// exact key bytes keep their own fixture.
export const COSE_HEX =
  "a5010203262001215820c728cac553ac9c7e6741694959adfbc1b5466df7071c8ea40fa05782c9628b8422582074d2fa89ce2b706497759bb98da015280bb379675f3476a378a6ce8a220ba639";

export function coseKey(): Buffer {
  return Buffer.from(COSE_HEX, "hex");
}

/** Minimal ChainRegistryService stub (unit specs; the rich EVM double stays local). */
export function minimalChainsStub() {
  return {
    activeChains: jest.fn(async () => []),
    deployableEvmChains: jest.fn(async () => []),
    deploymentFor: jest.fn(async () => null),
    chainByReference: jest.fn(async () => undefined),
    rpcUrlForReference: jest.fn(async () => "http://localhost:8545"),
    solanaChainIdOrThrow: jest.fn(async () => "chain-sol"),
    solanaChains: jest.fn(async () => []),
    solanaChain: jest.fn(async () => undefined),
    solanaRpcUrl: jest.fn(async () => "https://api.devnet.solana.com"),
    solanaProgramId: jest.fn(async () => "CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT"),
    networkLabel: jest.fn(async () => "devnet"),
    networkLabelFor: jest.fn(() => "devnet"),
    invalidate: jest.fn(),
  };
}
