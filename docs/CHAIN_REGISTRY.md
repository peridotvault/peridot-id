# Chain registry — dual-cluster (devnet + testnet) runbook

Server source of truth for chains, RPCs, and contract addresses.
Clients discover everything via `GET /v1/chains` — no chain/RPC/program env.

## Rows (seeded by `pnpm --filter @peridotvault/pid-api db:seed`, re-runnable)

| name | `(namespace, reference)` key | RPC | `program` contract |
|---|---|---|---|
| `solana-devnet` | `("solana", SOLANA_DEVNET_REFERENCE)` — legacy truncated-hash key, kept byte-stable | `https://api.devnet.solana.com` | `SOLANA_PROGRAM_ID` default |
| `solana-testnet` | `("solana", SOLANA_TESTNET_REFERENCE)` — live testnet genesis hash (verified 2026-10-18) | `https://api.testnet.solana.com` (or `SOLANA_TESTNET_RPC` env at seed time) | `SOLANA_TESTNET_PROGRAM_ID` = `D6TpM7…ALVsg3` default (or `SOLANA_TESTNET_PROGRAM_ID` env at seed time; on-chain deploy pending ANT-26) |

`chain_accounts` FKs by chain **id**, so adding/renaming rows never orphans
wallets. No schema migration is needed for a new chain — adding a chain is a
data row (expand), and deactivation (not delete) is the contraction path.

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

Per-user/session persistence + the HTTP surface (`?network=` vs header vs
stored preference) are defined by the ANT-15 spec (Theo, ANT-23) — this layer
only guarantees the server resolves any selection against the registry and
never trusts a client-supplied chain id.

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
