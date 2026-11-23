# Prisma, migrations, and data rules

## Stack and layout

Use Prisma 7 with PostgreSQL. `prisma.config.ts` loads `dotenv/config` because Prisma config does not load `.env` automatically. Schema files live in `prisma/schema/`, tracked SQL migrations in `prisma/migrations/`, and generated client output in `src/generated/prisma/`.

Never edit or commit generated Prisma output. Regenerate it with `pnpm --filter api db:generate` after schema changes.

## Schema rules

- Prisma field names use camelCase; database tables and columns use explicit `@map`/`@@map`.
- Primary keys use PostgreSQL UUID. Money uses `Decimal`, JSONB uses `Json`, and timestamps use `timestamptz`.
- Preserve ERD unique constraints and foreign keys. State relation deletion behavior explicitly and review data impact before changing it.
- Store password hashes, never plaintext. Email fields that identify users must be unique.
- Normalize domain codes at the boundary; keep raw import values in metadata when the domain requires it.
- Prefer soft deletion for user-visible records when history or audit trails depend on them. Do not hard-delete rows that other records reference without a reviewed migration.

## Repository ownership

Only `repositories/` may import `src/db/client.js` and issue Prisma queries. Services pass filters and pagination values to repository functions; they do not construct `Prisma.*` query objects for persistence.

Use explicit `select` shapes. Never expose password hashes, tokens, or internal secrets through a profile select. The `users.repository.ts` `profileSelect` is the reference pattern.

## Migration workflow

1. Change `prisma/schema/`.
2. Create and apply a local migration with `pnpm --filter api db:migrate -- --name <name>` or create-only via `db:migrate:create`.
3. Review the generated `migration.sql` before applying it anywhere shared.
4. Run `pnpm --filter api db:generate`, `pnpm --filter api exec prisma validate`, and `pnpm --filter api db:migrate:status`.
5. Commit schema and migration together with the code that depends on them.
6. Deploy with `pnpm --filter api db:deploy` and the target environment's `DATABASE_URL`.

Rules:

- Never use `prisma db push` for shared or deployed databases.
- Never edit a migration already applied to a shared environment.
- Never run `migrate dev` against production.
- Never reset a database containing data without explicit approval.
- If migration status diverges, stop and investigate before applying more commands.

## Environment and secrets

`src/env.ts` validates configuration once at process start. Staging and production require explicit `DATABASE_URL`, `CORS_ORIGINS`, and a `JWT_SECRET` of at least 32 characters. Development defaults are development-only.

Secrets live in untracked `.env` files or the platform secret manager. `.env.example` contains development examples only. CI checks for leaked secrets. Never print secrets in logs, errors, docs, or API responses.
