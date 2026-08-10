# 005 — DB: `wallets` Table + Migration

## Status

planned

## Objective

Add the minimum Prisma schema and migration that persists the wallet ↔ PID relationship
decided in task 003.

## Why

PRD §11: schema must represent `PID ├── Credentials └── Wallets` cleanly, with no provider
data duplicated into wallet records and no redundant identity data. The repo convention is
Prisma migrate (`pnpm db:migrate` / `db:deploy`), snake-cased `@@map` table names, and
data-preserving migrations (see `20260805045707_v2_identity_credentials`).

## PRD References

- §11 — Database
- §5 — Wallet Ownership (wallet relates to PID, not to Google)
- §12 — Backward Compatibility

## Repository Context

- `apps/api/prisma/schema.prisma` — existing models and conventions.
- `apps/api/prisma/migrations/` — two migrations; additive changes only so far.
- Existing relations from `identities` use `onDelete: Cascade` — whether `wallets` follows that
  or intentionally does not is a 003 lifecycle decision (PID deletion semantics); implement
  what the ADR says, with a comment.

## Scope

- Add a `Wallet` model to `schema.prisma` with exactly the fields the 003 ADR requires —
  expected shape: `id`, `identityId` (FK → `identities.id`), chain/address or provider
  reference fields per the custody decision, `createdAt`, and any status field the lifecycle
  decision needs. Nothing more (YAGNI: no multi-chain scaffolding, no token tables).
- Enforce the cardinality the ADR chooses (e.g. one wallet per PID → `identityId @unique`).
- Generate the migration via `prisma migrate dev`; verify it is additive and reversible-safe.
- Regenerate the Prisma client.

## Out of Scope

- Any wallet module/API code (task 006).
- Backfill of wallets for existing users unless the 003 ADR explicitly requires one (PRD §12
  default: no silent creation).
- Key-material storage columns — only if the custody ADR chose server custody, and then exactly
  as specified there (encrypted at rest, never plaintext).

## Dependencies

- 003 (wallet architecture ADR).

## Acceptance Criteria

- Migration applies cleanly on a fresh database and on a database containing V2 data
  (`identities`, `identity_credentials`, `profiles`, `devices`, `sessions` rows untouched).
- The wallet → identity relation exists with the ADR's cardinality and delete behavior.
- No provider (Google) fields exist on the wallet record (PRD §5, §11).
- `pnpm --filter @peridot/api db:generate` and `pnpm typecheck` pass.

## Testing Requirements

- Apply/rollback check locally against docker Postgres (`docker compose up -d`,
  `pnpm db:migrate`); confirm existing rows survive (backward-compat spot check per PRD §12).

## Security Considerations

- If (and only if) the custody ADR stores any sensitive material, the column-level handling
  (encryption, exclusion from default selects) must match the ADR verbatim.

## Migration Considerations

- This **is** the migration task. Production path: `pnpm db:deploy` against Supabase, matching
  the existing deploy flow. Document the step in task 009.
