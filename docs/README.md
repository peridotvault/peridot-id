# PeridotID

Gaming Identity Platform — Authentication, Identity, and Profile for the Peridot ecosystem.
One Google sign-in, one permanent identity (`<handle>@pid`), one personal wallet across
every Peridot product.

## Public docs

The developer documentation site lives in `apps/web` (Fumadocs + Next.js) and renders the
canonical OpenAPI spec in `packages/openapi/src/openapi.yaml`.

- Docs (Vercel): `https://pid.peridotvault.com`
- API (Vercel): `https://api.pid.peridotvault.com/v1`
- Run locally: `pnpm --filter @peridotvault/pid-web dev` → `http://localhost:3300`
- API also serves the raw spec at `GET /v1/openapi.yaml` (Swagger UI at `/docs`)

## Repository layout

```
apps/api            NestJS API (auth, identity, profile, wallet) — VPS via deploy/compose.yaml
apps/wallet         Expo wallet client (web + iOS + Android)
apps/web            Public docs site (Fumadocs)
contracts/svm       Pinocchio smart-account program (Rust)
contracts/evm       Counterfactual smart accounts (Solidity/Foundry)
packages/sdk-js     Browser SDK
packages/types      Shared TypeScript types
packages/openapi    OpenAPI 3.0 specification (source of truth)
packages/solana     Solana chain adapter (@solana/web3.js lives here only)
packages/evm        EVM adapter
packages/core       Browser-neutral primitives (hashes, WebAuthn, custody)
packages/pid-react  Hosted "Sign in with PeridotID" React flow
```

## Core docs

- [prds/PRD_v5.md](prds/PRD_v5.md) — current product spec (smart wallet)
- [prds/PRD_v4.md](prds/PRD_v4.md) — architecture base (note: its `PidAccount` model is
  superseded by [adr/008-remove-pid-account.md](adr/008-remove-pid-account.md))
- [ARCHITECTURE.md](ARCHITECTURE.md) — modules and repo layout
- [TECH_STACK.md](TECH_STACK.md) — NestJS, PostgreSQL, Prisma, JWT, Passport
- [DATABASE.md](DATABASE.md) — tables, ERD, invariants
- [API_SPEC.md](API_SPEC.md) — endpoint list
- [SECURITY.md](SECURITY.md) — auth, sessions, wallet threat model
- [ROADMAP.md](ROADMAP.md) — Foundation → Social → Gaming → Ecosystem
- [adr/](adr/) — accepted decisions 002–008 · [tasks/](tasks/README.md) — pre-mainnet hardening

## Quick start

```bash
docker compose up -d        # Postgres (refresh-token state lives in Postgres — no Redis)
pnpm install
pnpm --filter @peridotvault/pid-api db:deploy  # apply Prisma migrations
pnpm --filter @peridotvault/pid-api dev        # API on http://localhost:3301
pnpm --filter @peridotvault/pid-web dev        # docs on http://localhost:3300
pnpm --filter @peridotvault/pid-wallet dev:web # wallet on http://localhost:8081
```

Copy `apps/api/.env.example` to `apps/api/.env` and add Google OAuth credentials to test the
login flow. Local chain: run `solana-test-validator` from `contracts/svm` (see AGENTS.md).

## Deploy

See the public docs' [Self-hosting](https://pid.peridotvault.com/docs/self-hosting)
guide. In short: the API on the VPS (`deploy/compose.yaml`), `apps/web` per the deploy guide.
