# 003 — DB: V4 Account Model Migration

## Status

planned

## Objective

Implement the ADR 004 schema: `peridot_accounts`, `chain_accounts`, `authorities`,
`wallet_fee_payers`, `transactions`, `intents`, `security_events` — including the
`wallets → chain_accounts` data migration.

## Why

PRD_v4 §15 defines the target model; ADR 004 adapts it to the existing schema (identities =
users, identity_credentials = oauth_identities). Everything downstream (account API,
credentials, intents, transactions) persists through this task's tables.

## PRD References

- §15 (database model), §9 (server-side allowed/forbidden storage), §28 (Wallet:
  deterministically resolvable), §29 Phase 2

## Repository Context

- `apps/api/prisma/schema.prisma` — conventions: snake_case `@@map`, `IdentityStatus` enum,
  defensive `onDelete: Cascade`, data-preserving migrations.
- `wallets` rows are production data (ADR 003): copy → verify → drop, never lose.
- Migration tooling: `pnpm db:migrate` (dev), `pnpm db:deploy` (Supabase prod).

## Scope

- New Prisma models exactly per ADR 004 §2/§3/§6 — including
  `@@unique([account_id, chain_namespace, chain_reference, account_type])` on
  `chain_accounts` and `account_type ∈ {smart_account, linked_address}`.
- Data migration: create default `peridot_accounts` for wallet-holding identities → copy
  `wallets` rows as `linked_address` chain accounts → verify counts → drop `wallets`.
- **No smart-account backfill** (ADR 004 §4; explicit user action only).
- Regenerate Prisma client; update `docs/DATABASE.md` ERD.

## Out of Scope

- Any module/API code (task 004).
- Key-material columns of any kind (structurally forbidden — ADR 004/006).
- SPL token/account subtables (YAGNI).

## Dependencies

- 001 (ADR 004).

## Acceptance Criteria

- Migration applies cleanly on fresh DB and on a copy of production-shaped V2/V3 data; all
  pre-existing rows survive; every `wallets` row appears in `chain_accounts`.
- No provider (Google/Discord) fields on any wallet-side table (PRD_v3 §5/§11).
- No key-material columns anywhere.
- `pnpm --filter @peridot/api db:generate` and `pnpm typecheck` pass.

## Testing Requirements

- Apply/rollback against docker Postgres; row-count verification pre/post copy; spot-check a
  migrated `linked_address` row end-to-end through the old V3 query path.

## Security Considerations

- Verify by inspection that no column can hold secret material (ADR 006 §1: structural, not
  policy).
- The drop of `wallets` runs only after copy verification passes inside the same migration.

## Migration Considerations

- This **is** the migration task. Production: `pnpm db:deploy`; document the operator step
  and rollback story in the PR description.
