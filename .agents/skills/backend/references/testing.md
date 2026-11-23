# Testing and delivery

## Test placement

```text
tests/
├── unit/core/          # shared helpers, schemas, bootstrap units
├── unit/feature/       # module schemas and service rules
├── unit/integration/   # unit-level cross-layer orchestration, no real DB
├── unit/scripts/       # implementations under src/scripts
├── integration/        # HTTP and real PostgreSQL flows
├── perf/               # load test scripts
└── fixtures/           # shared fixtures only when needed
```

Do not place `*.test.ts` directly in `tests/unit/`. Add `tests/fixtures/` only when a shared fixture is actually needed by more than one test. Never place `*.test.*` or `*.spec.*` under `src/`; `src/` is application code only. For example, `src/modules/users/api/users.test.ts` is invalid; the unit test belongs in `tests/unit/feature/` or the integration test in `tests/integration/`.

## Test responsibilities

- Unit core tests cover shared helpers, env parsing, response helpers, tokens, pagination, and file/token utilities.
- Unit feature tests cover Zod contracts and business rules without PostgreSQL. The `users` module's schema test is the reference.
- Unit integration tests exercise cross-layer orchestration with fakes or in-memory collaborators; they must not require a database.
- Integration tests send real HTTP requests through the app and persist to local PostgreSQL. Use unique emails or IDs, log in to obtain a bearer token, and clean up only rows the test created.
- Performance scripts live in `tests/perf/` and are run explicitly, not as part of unit tests.
- OpenAPI tests verify that every `/api/v1` route is documented and that real response shapes match `responseShapes` in `src/openapi.ts`.

## Commands

Run from the repository root:

```sh
pnpm --filter api test:unit
pnpm --filter api test:integration
pnpm --filter api test
pnpm lint
pnpm check-types
pnpm build
```

`test:unit` must pass without PostgreSQL. `test:integration` requires a running, migrated local database. When the schema changes, also run `db:generate`, `prisma validate`, and `db:migrate:status`.

## Completion checklist

- Architecture validator passes for the backend app.
- Lint, type-check, build, and relevant tests pass.
- New module layers are complete and no empty folder was added.
- Route changes include OpenAPI updates and contract tests.
- Schema changes include reviewed migrations and client generation.
- Project phase checklists such as `docs/development/IMPLEMENTATION-ROADMAP.md` are updated when the repository requires it.
- Report any command that could not run and any unresolved violation. Never claim a check passed without its output.
