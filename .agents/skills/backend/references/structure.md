# Structure and ownership

## Mandatory application structure

Every Arctis backend application uses module ownership and the same four layers per module. Minimal bootstrap files may sit at `src/` root; application logic belongs in the module layers.

```text
apps/api/
├── prisma.config.ts
├── prisma/
│   ├── schema/
│   └── migrations/
├── Dockerfile
├── tests/
│   ├── unit/
│   │   ├── core/
│   │   ├── feature/
│   │   ├── integration/
│   │   └── scripts/
│   ├── integration/
│   ├── perf/
│   └── fixtures/
└── src/
    ├── index.ts
    ├── app.ts
    ├── env.ts
    ├── routes.ts
    ├── openapi.ts
    ├── db/client.ts
    ├── generated/prisma/
    ├── modules/<module>/
    │   ├── api/
    │   ├── schemas/
    │   ├── services/
    │   └── repositories/
    ├── integrations/
    └── shared/
```

`integrations/` is optional and exists only when an external client is actually implemented. `generated/` contains generated output; never edit or commit it. Do not create empty folders or layers for future work. Add a directory only with real code.

## Module layers

Each immediate child of `src/modules/` is one independent module. The four layer directories are required for every module:

- `api/`: Hono routers, route registration, authentication guards, request parsing, status codes, and response shaping. Keep handlers thin.
- `schemas/`: Zod contracts for bodies, queries, params, and shared input types. Schemas do not call services or repositories.
- `services/`: business rules, orchestration, authorization decisions that need domain data, error mapping, and audit calls. Services do not import Hono context or the Prisma client.
- `repositories/`: all Prisma queries and persistence details. Expose operations that services need instead of leaking query construction upward.

The repository's `users` module is the reference example:

```text
src/modules/users/
├── api/users.ts
├── schemas/user.schema.ts
├── services/users.service.ts
└── repositories/users.repository.ts
```

`api/users.ts` mounts a Hono router, applies `requireAuth` and `requireRole`, parses input with `parseInput`/`parseJsonBody`, calls service operations, and returns `ok`. `services/users.service.ts` hashes passwords, checks ownership, maps missing records to `HttpError`, increments `tokenVersion` on role changes, and records activity. `repositories/users.repository.ts` owns `prisma.user.*`, uses `profileSelect`, and never returns `passwordHash` through the profile shape.

## Shared and root code

`src/shared/` contains genuinely feature-independent infrastructure: HTTP helpers, auth primitives, pagination, audit helpers, date and filtering utilities, storage helpers, and cross-module contracts. It may import other shared modules and external packages. It must not import `src/modules/`.

Root bootstrap files own composition:

- `src/routes.ts` mounts every module router under `/api/v1`.
- `src/app.ts` installs middleware, error handling, health checks, docs, and feature routes.
- `src/env.ts` validates runtime configuration once.
- `src/openapi.ts` describes the HTTP contract.
- `src/db/client.ts` creates the Prisma client.
- `src/index.ts` starts the Node server and handles shutdown.

`src/scripts/` may orchestrate module services for maintenance jobs. Do not expose scripts as HTTP endpoints by default.

## Test placement

```text
tests/
├── unit/core/          # shared helpers, schemas, bootstrap units
├── unit/feature/       # module schemas and business rules
├── unit/integration/   # unit-level cross-layer orchestration
├── unit/scripts/       # src/scripts implementations
├── integration/        # real PostgreSQL and HTTP flows
├── perf/               # load-test scripts
└── fixtures/           # shared fixtures only when needed
```

Do not put `*.test.ts` directly in `tests/unit/`. Integration tests use unique data and clean up only their own rows. Never put `*.test.*` or `*.spec.*` under `src/`; source and tests stay separate. See [testing](testing.md).
