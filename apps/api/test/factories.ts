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
    invalidate: jest.fn(),
  };
}
