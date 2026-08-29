# 006 — Solana Adapter + RPC Abstraction

## Status

implemented (2026-08-28) — `packages/solana` verified end-to-end against
`solana-test-validator`.

## Delivered

- `ChainRpc` (rpc.ts): getLatestBlockhash / sendTransaction (skipPreflight — the precompile
  does not simulate correctly) / getTransaction / getBalance / getAccountInfo / getBlockTime
  (chain clock for passkey expiries).
- `SolanaAdapter` (adapter.ts): getAddress (PDA) / getNonce / isInitialized / initialize /
  depositSol / depositToken (idempotent ATA + transfer) / withdrawSol / withdrawToken /
  updateAuthority / send / getStatus / getBalance. Passkey operations build the
  domain-separated payload, request a WebAuthn assertion, low-S normalize, and assemble
  program-ix-first / secp256r1-precompile-ix-second.
- Instruction builders (instructions.ts) matching the program byte-for-byte; pure helpers
  (core.ts): domain separator, payload hash, low-S normalization, compressed-pubkey
  conversion, WebAuthn message construction, PDA derivation.
- Only package allowed to import `@solana/web3.js` / `@solana/spl-token` (ADR 007 §8).

## Verification

`test/adapter.e2e.mjs` against a local validator: initialize → deposit SOL → passkey
(mock signer) withdraw → confirmed, nonce 0→1, ~36,460 CU. Full `pnpm typecheck` green.

## Notes for downstream

- The passkey signer is injected (`PasskeySigner`); the browser/Expo WebAuthn
  implementation lands in task 009.
- Fee payer is a client-held Ed25519 keypair passed per-operation (ADR 006 §2).
- The compressed authority pubkey comes from the credential API (task 003 `publicKey`).

## Objective

Create `packages/solana`: the `ChainAdapter` + `ChainRpc` implementation (PRD_v4 §5.6/§19)
that builds, submits, and tracks Solana transactions against the Pinocchio program — the
only package allowed to touch `@solana/web3.js`. It also builds the deposit transactions
(plain transfers + idempotent ATA creation — PRD_v5 §4), which need no program
instruction.

## Why

PRD_v4 §2 Principle 6: chain-specific code lives behind adapters. §19: RPC provider is
config, not code. The API (007) and SDK (009) consume this package; nothing else imports
web3.js (ADR 007 §8).

## PRD References

- PRD_v5 §4 (deposits/ATAs), §5; PRD_v4 §5.6 (ChainAdapter interface), §13 (transaction
  flow), §19 (RPC architecture), §21 (environments)

## Repository Context

- New workspace package `packages/solana` (tsconfig/base conventions like `packages/types`).
- `@solana/web3.js` — new dependency justified by ADR 007 (Consequences). No Anchor
  client/IDL exists (ADR 007 §1 amendment): the program's discriminators and account
  layouts are mirrored here and kept in sync with task 004's crate.
- Env: `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `SOLANA_NETWORK` (PRD_v4 §19); local validator for
  tests (005's toolchain).

## Scope

- `ChainRpc` implementation: getLatestBlockhash, sendTransaction, getTransaction, getBalance
  — over configurable RPC/WS URLs.
- `SolanaAdapter` implementing PRD_v4 §5.6 verbatim: `createAccount` (build initialize ix),
  `getAddress` (PDA derivation — shared vectors with 002), `buildTransaction` (domain-
  separated withdraw action → unsigned tx with user fee payer attached),
  `signTransaction` (via injected `WalletSigner` — the client credential),
  `sendTransaction`, `getTransactionStatus` (commitment-aware).
- Deposit builder: SOL plain transfer; SPL plain transfer + `create_idempotent` ATA when
  missing (PRD_v5 §4); first-top-up composition = initialize ix + deposit in one tx
  (PRD_v5 §3).
- Fee payer attachment per ADR 006 §2: the transaction's fee payer is the user-controlled
  Ed25519 key; the adapter never holds its secret — signing is by injected signer.
- Blockhash management + confirmation polling utilities (used by SDK in 009).

## Out of Scope

- EVM or other adapters (interface exists; implementations are future work — YAGNI).
- Intent/policy logic (007) and SDK UX (009).
- RPC failover/multi-endpoint logic (task 012 hardening).

## Dependencies

- 004 (program). Blocks 007, 009.

## Acceptance Criteria

- Against local validator: build → sign (test keypair) → submit → confirm a smart-account
  SOL withdrawal; nonce increments; status polling reflects cluster truth.
- Deposit builder: SPL deposit to a smart account with no ATA creates the ATA in the same
  tx; existing-ATA deposit is transfer-only.
- PDA derivation matches 002's off-chain result and on-chain seeds (shared test vectors).
- Switching `SOLANA_RPC_URL` between local validator and devnet requires zero code change.
- Unit tests for transaction building and domain-separated encoding.

## Security Considerations

- The adapter validates the on-chain response instead of trusting a single RPC answer
  (commitment levels; PRD_v4 §23.11).
- No signing secrets ever enter the adapter — signer is an injected interface (ADR 006).
