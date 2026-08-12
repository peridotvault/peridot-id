# ADR 007 — Solana Program & Chain Adapter Architecture

Status: accepted

This ADR records the on-chain and chain-access decisions of PRD_v4 (§5.6, §7, §11, §19,
§24, §25, §26). Together with ADR 004 (account model), ADR 005 (authority), and ADR 006
(security/recovery) it completes PRD_v4 Phase 0.

## Context

The repository contains **zero** blockchain code or dependencies today
(`docs/ARCHITECTURE_AUDIT_V3.md` §3). PRD_v4 requires: a Solana smart-account program (§11),
a chain adapter layer so chain specifics never leak into the core (§2 Principle 6, §5.6), and
a replaceable RPC abstraction (§19). The repo is a pnpm TypeScript monorepo (`apps/api`,
`apps/docs`, `packages/{openapi,types,sdk-js}`); there is no Rust workspace yet.

## Decision

### 1. Framework — Anchor

PRD_v4 §11: "Use Anchor unless there is a strong technical reason to use native Rust." No
strong reason exists (team is TypeScript-first; Anchor gives IDL, account validation, and
test tooling for free). Workspace layout per PRD_v4 §20:

```text
programs/peridot-smart-account/
  Anchor.toml
  Cargo.toml
  src/lib.rs, state.rs, errors.rs, instructions/{initialize,execute,update_authority,close}.rs
```

### 2. Account state — PDA, model-sized authority

- PDA seeds: `["peridot", "account", account_id]` with `account_id` = 32-byte derivation from
  `peridot_accounts.id` (ADR 004 §5). The PDA holds SOL/SPL assets; the program controls it.
- State: `account_id: [u8; 32]`, `authority` (**sized per ADR 005**: 32 B Ed25519 or 33/64 B
  secp256r1 — PRD_v4 §7.1 note; stored with a 1-byte model tag), `status: u8`,
  `nonce: u64`, `version: u8`. No 32-byte hardcoding if ADR 005 selects secp256r1.

### 3. Instructions

- `initialize(account_id, authority)` — creates the PDA, sets authority/nonce=0/version=1,
  emits `AccountInitialized`. Anyone may pay rent for creation, but the recorded authority is
  fixed at creation and comes from the authenticated registration flow (ADR 005/006).
- `execute(nonce, action)` — the only value-moving path. Must, in order (PRD_v4 §11.2):
  verify authority per the ADR 005 model; verify `nonce == account.nonce`; decode and
  validate the domain-separated action (§5 below); perform the allowed CPI; increment nonce;
  emit `TransactionExecuted`. **No placeholder authorization, ever** (PRD_v4 §11.2, §24,
  §32 — mock checks are test-only).
- `update_authority(new_authority)` — rotation; authorized by a current valid authority;
  emits `AuthorityUpdated` (PRD_v4 §10/§24).
- `close` — rent reclamation/teardown; emits `AccountClosed`. Exists in the program, **not
  exposed by any V1 API** (ADR 004 lifecycle: a DB delete must not destroy an on-chain
  account).

### 4. Controlled CPI — allowlist, not arbitrary

V1 `execute` permits exactly: **System Program SOL transfer** from the smart account. SPL
token transfer is added only if it fits the same allowlist mechanism cleanly (PRD_v4 §28).
Arbitrary CPI is explicitly prevented (PRD_v4 §24): the program validates target program id
and account set per action type; no generic "call any program with any data" instruction.

### 5. Domain separation & replay

- Signed/executed payload is domain-separated (PRD_v4 §25):
  `PERIDOT | SOLANA | SMART_ACCOUNT | v1` + {account, chain, network, action, destination,
  asset, amount, nonce, expiration}.
- Replay protection: on-chain `nonce` (strictly sequential, §3) + intent expiration enforced
  off-chain (ADR 004 `intents.expires_at`) and recent-blockhash validity on-chain.
- If ADR 005 selects secp256r1: verification runs through the native secp256r1 precompile
  via instruction introspection, with the WebAuthn challenge cryptographically bound to the
  domain-separated payload (ADR 005 Option B; PRD_v4 §8.2/§12).

### 6. Events

`AccountInitialized`, `AuthorityUpdated`, `TransactionExecuted`, `TransactionRejected`,
`NonceUpdated`, `AccountClosed` (PRD_v4 §26) — indexable for debugging/analytics.

### 7. Upgrade authority

Program deploys upgradeable on devnet/mainnet. The upgrade authority key is held by the
stakeholder (hardware wallet before mainnet; multisig acceptable) — **never** in the repo,
CI, Vercel env, or developer laptops' plaintext files (PRD_v4 §24/§29 Phase 7). Holder and
rotation procedure are documented in task 013 before mainnet.

### 8. Chain adapter & RPC abstraction (packages/solana)

- New `packages/solana` implements PRD_v4 §5.6 `ChainAdapter`
  (createAccount/getAddress/buildTransaction/signTransaction/sendTransaction/
  getTransactionStatus) and §19 `ChainRpc`
  (getLatestBlockhash/sendTransaction/getTransaction/getBalance). V1 ships `SolanaAdapter`
  only; `EvmAdapter` is a future implementation of the same interface, not scaffolding built
  now (YAGNI).
- Config via env: `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `SOLANA_NETWORK` (PRD_v4 §19).
  No RPC vendor is hardcoded into business logic; production provider is replaceable config.
- The API/intent layer talks to the adapter, never to web3.js directly (PRD_v4 §2 P6).
- Malicious-RPC posture (PRD_v4 §23.11): confirmation is verified against cluster state
  (commitment levels), and task 013 adds multi-endpoint failover; a lying RPC can misreport
  but cannot forge execution.

### 9. Environments

`local` (solana-test-validator, added to docker-compose for tests), `devnet` (staging),
`mainnet` (production) per PRD_v4 §21. Production credentials/RPC are never used locally.

## Rejected alternatives

- **Native Rust program** — rejected: no strong technical reason over Anchor (PRD_v4 §11
  default stands).
- **Arbitrary-CPI generic executor** — rejected: violates PRD_v4 §24; unbounded attack
  surface for zero V1 need.
- **RPC calls embedded in NestJS controllers/modules** — rejected: violates the adapter
  principle (§2 P6) and vendor lock-in rule (§19).
- **Immutable (non-upgradeable) program at devnet stage** — rejected for V1 velocity;
  upgradeability with a secured authority is the pragmatic path; freezing is a
  post-mainnet-audit decision (task 013).
- **Program-side fee sponsorship (program pays rent/fees from a treasury PDA)** — rejected:
  violates PRD_v4 §14 (no sponsorship in V1).

## Consequences

- New workspace members: `programs/peridot-smart-account` (Rust/Anchor) and
  `packages/solana` (TypeScript). CI gains `anchor test` and program lint steps (task 008).
- `packages/solana` is the only package allowed to depend on `@solana/web3.js` (and Anchor
  client libs); the dependency is ADR-justified here per the tasks README convention.
- Tasks: 007 (program), 008 (tests + devnet deploy), 010 (adapter/RPC), 009 (intent/policy
  consuming the adapter), 011 (SDK over the adapter).
- Devnet program id and upgrade-authority custody are recorded in task 008/013 outputs.

## Security considerations

- PRD_v4 §24's full rule list is the acceptance checklist for task 007/008: authority
  verification, exact-message binding, replay prevention, PDA/seed validation, target
  program/account validation, no arbitrary CPI, no unauthorized lamport/token movement,
  events, controlled rotation, versioning, secured upgrade authority.
- On-chain code never trusts the Peridot backend or OAuth session (PRD_v4 §24: no
  `if user_is_authenticated { execute(); }`).
- Compute-budget and precompile limits for the secp256r1 path are validated in task 008
  before devnet deploy (ADR 005 fallback trigger).

## Migration considerations

None on-chain (no prior program exists). Devnet → mainnet is a fresh deploy with a new,
secured upgrade authority; devnet program id is never reused for mainnet (task 013).

## References

- PRD_v4 §2 P6, §5.6, §7, §11, §12, §19, §21, §24, §25, §26, §27 (Program Tests), §28
  (Solana), §29 Phase 4, §32.
- ADR 004 (PDA derivation, account model), ADR 005 (authority model & sizing), ADR 006 (fee
  payer, no sponsorship).
- `docs/ARCHITECTURE_AUDIT_V3.md` §3 (zero blockchain evidence).

Blocks: tasks 007 (program), 010 (adapter).
