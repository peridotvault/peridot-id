# 010 — Solana Adapter + RPC Abstraction

## Status

planned

## Objective

Create `packages/solana`: the `ChainAdapter` + `ChainRpc` implementation (PRD_v4 §5.6/§19)
that builds, submits, and tracks Solana transactions against the Anchor program — the only
package allowed to touch `@solana/web3.js`.

## Why

PRD_v4 §2 Principle 6: chain-specific code lives behind adapters. §19: RPC provider is
config, not code. The API (009) and SDK (011) consume this package; nothing else imports
web3.js (ADR 007 §8).

## PRD References

- §5.6 (ChainAdapter interface), §13 (transaction flow), §19 (RPC architecture), §21
  (environments), §29 Phase 5

## Repository Context

- New workspace package `packages/solana` (tsconfig/base conventions like `packages/types`).
- `@solana/web3.js` + Anchor client — new dependencies justified by ADR 007 (Consequences).
- Program IDL from 007 is the typed client source.
- Env: `SOLANA_RPC_URL`, `SOLANA_WS_URL`, `SOLANA_NETWORK` (PRD_v4 §19); local validator for
  tests (008's toolchain).

## Scope

- `ChainRpc` implementation: getLatestBlockhash, sendTransaction, getTransaction, getBalance
  — over configurable RPC/WS URLs.
- `SolanaAdapter` implementing §5.6 verbatim: `createAccount` (build initialize ix),
  `getAddress` (PDA derivation — shared vectors with 004), `buildTransaction` (domain-
  separated execute action → unsigned tx with user fee payer attached),
  `signTransaction` (via injected `WalletSigner` — the client credential), `sendTransaction`,
  `getTransactionStatus` (commitment-aware).
- Fee payer attachment per ADR 006 §2: the transaction's fee payer is the user-controlled
  Ed25519 key; the adapter never holds its secret — signing is by injected signer.
- Blockhash management + confirmation polling utilities (used by SDK in 011).

## Out of Scope

- EVM or other adapters (interface exists; implementations are future work — YAGNI).
- Intent/policy logic (009) and SDK UX (011).
- RPC failover/multi-endpoint logic (task 013 hardening).

## Dependencies

- 001 (ADR 007), 007 (program + IDL). Blocks 009, 011.

## Acceptance Criteria

- Against local validator: build → sign (test keypair) → submit → confirm a smart-account
  SOL transfer; nonce increments; status polling reflects cluster truth.
- PDA derivation matches 004's off-chain result and on-chain seeds (shared test vectors).
- Switching `SOLANA_RPC_URL` between local validator and devnet requires zero code change.
- Unit tests for transaction building and domain-separated encoding.

## Security Considerations

- The adapter validates the on-chain response instead of trusting a single RPC answer
  (commitment levels; PRD_v4 §23.11).
- No signing secrets ever enter the adapter — signer is an injected interface (ADR 006).
