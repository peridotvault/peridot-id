# Chain registry — dual-cluster (devnet + testnet) runbook

Server source of truth for chains, RPCs, and contract addresses.
Clients discover everything via `GET /v1/chains` — no chain/RPC/program env.

## Rows (seeded by `pnpm --filter @peridotvault/pid-api db:seed`, re-runnable)

| name | `(namespace, reference)` key | RPC | `program` contract |
|---|---|---|---|
| `solana-devnet` | `("solana", SOLANA_DEVNET_REFERENCE)` — legacy truncated-hash key, kept byte-stable | `https://api.devnet.solana.com` | `SOLANA_PROGRAM_ID` = `9oMG7e…ECce` default (fresh devnet program, ANT-68 Option B; re-seed heals stale rows via `update: { address }`; old program `CiwLJ1h…Xf6NT` left untouched on-chain as the rollback path) |
| `solana-testnet` | `("solana", SOLANA_TESTNET_REFERENCE)` — live testnet genesis hash (verified 2026-10-18) | `https://api.testnet.solana.com` (or `SOLANA_TESTNET_RPC` env at seed time) | `SOLANA_TESTNET_PROGRAM_ID` = `D6TpM7…ALVsg3` default (or `SOLANA_TESTNET_PROGRAM_ID` env at seed time; verified live on testnet 2026-10-18, slot 453908238 — unchanged by ANT-70) |
| `stellar-testnet` | `("stellar", STELLAR_TESTNET_REFERENCE)` — F1 `network_id` hex `cee0302d…ecd472` = `sha256("Test SDF Network ; September 2015")` (S1 §5.2, OQ-S1 proposed; if CTO picks the raw passphrase, re-key mechanically) | `https://horizon-testnet.stellar.org` (or `STELLAR_TESTNET_RPC` env at seed time) | `factory` contract = `STELLAR_FACTORY_ADDRESS` env at seed time (the §1 deployed factory, `versionLabel: "v1"`; row seeds without a contract until the deploy lands, re-seed heals rotations — no `program`-type row required for stellar) |

`chain_accounts` FKs by chain **id**, so adding/renaming rows never orphans
wallets. No schema migration is needed for a new chain — adding a chain is a
data row (expand), and deactivation (not delete) is the contraction path.

## Valid contract types per namespace

| namespace | valid `chainContract.type` values |
|---|---|
| `solana` | `program` (one per row) |
| `eip155` | `factory` + `account_implementation` (deployable pair) |
| `stellar` | `factory` (one per row; the §1 deployed factory, `versionLabel: "v1"`) |

Unknown/over-long/inactive reference selection fails closed `400 UNKNOWN_CHAIN`
(existing behavior, regression-pinned — AC5.6).

## Selection scoping (ANT-15 req 1)

`ChainRegistryService` resolves everything per `SolanaSelection`
(`"devnet" | "testnet"`, default `"devnet"` = historical behavior):

- `solanaChain(selection?)`, `solanaChains()`, `solanaChainIdOrThrow(selection?)`
  (fail-fast 404 preserved: default message unchanged; selection misses name
  the selection), `solanaRpcUrl(selection?)`, `solanaProgramId(selection?)`,
  `networkLabel(selection?)` / `networkLabelFor(chain)`.
- Activation / relay / quote / fee paths (`ActivationService`,
  `SponsoredWithdrawService`, `RotateService`, `IntentService`,
  `AccountService.ensureAccount`) accept an optional trailing `selection`
  and use the selected chain's RPC + program + label. Omitted = current
  behavior. The activation poll groups pending rows by chain and quotes each
  group against its own cluster.
- Standard lifecycle guards are untouched: intent/authorization TTL stays
  `<= 600s`, nonce semantics unchanged.

Per-user/session persistence + the HTTP surface are defined by the ANT-15
spec (Theo, ANT-23) §5/§8 and implemented in ANT-35 — this layer only
guarantees the server resolves any selection against the registry and
never trusts a client-supplied chain id.

## HTTP surface (ANT-35, spec §8)

How the wallet's network-mode selection travels, per chain-dependent endpoint:

- Transport: `X-Chain-Reference: <reference>` header (recommended).
  `?chainReference=<reference>` query is the GET-friendly fallback
  (explorer-style links); **header wins** when both are present.
- Absent/blank ⇒ server default (current behavior, AC-1.3) — existing
  clients that send no selection keep today's mainnet-path behavior.
- Unknown, over-long (> 128 chars), or inactive reference ⇒
  `400 { code: "UNKNOWN_CHAIN", message }`, fail-closed with no chain
  write (AC-1.4). A registered-but-unserved row (e.g. a future third
  Solana row the service layer cannot map yet) also fails closed rather
  than silently serving another cluster.
- Scoped endpoints: `POST /v1/wallet/withdraw/quote`, `POST /v1/wallet/withdraw`,
  `POST /v1/wallet/execute`, `POST /v1/wallet/execute/quote`,
  `POST /v1/wallet/rotate`, `POST /v1/account` (per-chain smart-row setup),
  `GET /v1/account/activation`, `POST /v1/account/activate`,
  `POST /v1/wallet/intents`, `POST /v1/wallet/transactions` (activity).
- Unscoped (documented): `GET /v1/wallet/me`, `POST /v1/wallet` (identity
  linked-address row, default chain), `GET /v1/account[/chains]` (returns
  every row), intent/transaction reads, `GET /v1/chains`, EVM paths
  (AC-5.5), session-keys, fiat (gating list per OQ-2; wallet gates the UI —
  server-side enforcement without a stored preference is spoofable by
  omitting the header, flagged for ANT-27).
- Resolution cost is one cached registry read (30s server cache kept):
  p95 ≤ 10ms vs today (NFR §12). The wallet SHOULD echo-verify via
  `GET /v1/chains`; response shapes are unchanged in v1 (FR-7 backward
  compat — no `chain` echo field yet; notify FrontendEngineer before
  adding one).

## Persistence decision (ANT-35, spec OQ-5)

Session-scoped only (recommended option): the wallet persists
`localStorage pid_network_mode` (`shared/network-mode.ts`, default OFF)
and sends the selection per request. **No per-user preference is stored
server-side in v1** — no Profile field, no migration. The server is the
source of truth for registry data (RPC/program per selection), not for
the preference. `PATCH /v1/profile` is unchanged on purpose.

## Admin: add / activate a chain row

All via `v1/admin` (admin JWT), every write invalidates the registry cache
and emits a security event:

1. `POST /v1/admin/chains` with `{ namespace: "solana", reference, name,
   nativeSymbol: "SOL", decimals: 9, rpcUrls: ["https://..."], explorerUrl,
   isTestnet: true }`. Secrets never go here — relayer keys stay in env.
2. `POST /v1/admin/chains/:id/contracts` with `{ type: "program", address,
   versionLabel }` — one `program` contract per chain row. (EVM rows use
   `factory` + `account_implementation`; those types are rejected on solana rows.)
3. Verify: `GET /v1/admin/chains` shows the row with contracts;
   `GET /v1/chains` exposes it publicly.
4. To retire: `PATCH /v1/admin/chains/:id { isActive: false }` (never delete —
   history rows reference the id). To re-point RPC/program, update the row or
   upsert the contract; no redeploy needed.

## Translating chain ops (Thomas) values into rows

- New RPC endpoint → row `rpcUrls[0]` (first entry wins; keep ≤ 5).
- New program deploy → upsert `program` contract for that chain's row only;
  other rows are unaffected, and derived PDA addresses follow automatically
  because `ensureAccount` derives from the selected row's program id.
- `PID_PROGRAM_ID`-era env values are seed/bootstrap defaults only; the live
  value is always the row's `program` contract.
