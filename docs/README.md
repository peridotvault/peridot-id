# Peridot ID

Gaming Identity Platform — Authentication, Identity, and Profile for the Peridot ecosystem.

## Public docs

The developer documentation site lives in `apps/docs` (Fumadocs + Next.js) and renders the
canonical OpenAPI spec in `packages/openapi/src/openapi.yaml`.

- Run locally: `pnpm --filter @peridot/docs dev` → `http://localhost:3000`
- API also serves the raw spec at `GET /v1/openapi.yaml` (Swagger UI at `/docs`)

## Repository layout

```
apps/api            NestJS API (auth, identity, profile)
apps/docs           Public docs site (Fumadocs)
packages/sdk-js     Browser SDK
packages/types      Shared TypeScript types
packages/openapi    OpenAPI 3.0 specification (source of truth)
```

## Core docs

- [PRD.md](PRD.md) — scope v1 (Google login, JWT + refresh, identity, profile, JS SDK)
- [ARCHITECTURE.md](ARCHITECTURE.md) — modules and repo layout
- [TECH_STACK.md](TECH_STACK.md) — NestJS, PostgreSQL, Redis, Prisma, JWT, Passport
- [DATABASE.md](DATABASE.md) — ERD (identities, auth_accounts, profiles, devices, sessions)
- [API_SPEC.md](API_SPEC.md) — endpoint list
- [SECURITY.md](SECURITY.md) — cookies, token rotation, rate limiting
- [ROADMAP.md](ROADMAP.md) — Foundation → Social → Gaming → Ecosystem

## Quick start

```bash
docker compose up -d        # Postgres + Redis
pnpm install
pnpm db:migrate             # apply Prisma migrations
pnpm dev                    # API on http://localhost:3000
```

Copy `apps/api/.env.example` to `apps/api/.env` and add Google OAuth credentials to test the
login flow.
