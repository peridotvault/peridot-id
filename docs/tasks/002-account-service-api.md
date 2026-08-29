# 002 — Account Service + Account API

## Status

planned

## Objective

Implement the Account Service (PRD_v4 §5.2) as a NestJS module with the account REST
surface: create/get accounts, create/get chain accounts, deterministic Solana smart-account
address resolution.

## Why

PRD_v4 §5.2: map user → PeridotID account → chain accounts, store public addresses and
authority metadata, track initialization status. The smart-account address must be
deterministically resolvable **before** on-chain initialization (PRD_v4 §28) so the client
can show the wallet address immediately (ADR 004 §5, PRD_v5 §7).

## PRD References

- PRD_v5 §2, §7; PRD_v4 §5.2 (Account Service), §7.1 (PDA), §15 (schema), §16 (Accounts
  API), §28 (Wallet)

## Repository Context

- Existing modules (`auth`, `identity`, `profile`, `wallet`) show the NestJS + Prisma +
  guard conventions; `JwtAuthGuard` → `AuthenticatedUser { identityId }`.
- Contract-first: `packages/openapi/src/openapi.yaml` → `packages/types` → `sdk-js`.
- V3 `GET /v1/wallet/me` / `POST /v1/wallet` must keep working against migrated
  `linked_address` rows and be marked deprecated (ADR 004 Consequences).

## Scope

- `account` module: `createAccount`, `getAccount`, `getUserAccounts`, `createChainAccount`,
  `getChainAccount` (PRD_v4 §5.2 conceptual API → service methods).
- REST: `POST /v1/accounts`, `GET /v1/accounts`, `GET /v1/accounts/:id`,
  `GET /v1/accounts/:id/chains`.
- PDA derivation util (seeds `["peridot","account",account_id]` per ADR 007 §2) shared with
  the adapter package (task 006); zero-padded UUID→[u8;32] documented here.
- Default-account bootstrap: first `POST /v1/accounts` (or first login if product chooses)
  creates the single default account (ADR 004 §2: API exposes 1).
- V3 wallet endpoints re-backed by `chain_accounts` (linked_address only), deprecated in
  OpenAPI.

## Out of Scope

- On-chain initialization (program interaction — tasks 004/006).
- Intent/transaction endpoints (task 007).
- Multi-account product UX (schema permits, V1 hides).

## Dependencies

- 001 (schema). Blocks 003, 007, 009.

## Acceptance Criteria

- A new identity can create an account and see a Solana `smart_account` chain account whose
  address matches the PDA derivation (unit-tested against known vectors).
- Address is stable across logins/devices (PRD_v4 §28).
- Ownership resolution strictly from the token — no client-supplied identity/account id
  (no IDOR); throttled per existing convention.
- V3 wallet endpoints unchanged in behavior for existing clients.
- `pnpm typecheck`, existing tests, and new module tests pass.

## Security Considerations

- Account creation emits `security_events` (ADR 004).
- Responses contain public fields only (id, addresses, status) — nothing sensitive exists to
  leak; keep DTOs structurally minimal (ADR 003 rule carried).
