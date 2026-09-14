# PeridotID

Gaming Identity Platform — Authentication, Identity, and Profile for the Peridot ecosystem.
One Google sign-in, one permanent identity (`ifal@pid`), one personal wallet across
every Peridot product.

## Live URLs

| Service | URL |
|---|---|
| API | `https://api.pid.peridotvault.com/v1` |
| Docs | `https://pid.peridotvault.com` |
| OpenAPI spec | `GET /v1/openapi.yaml` (Swagger UI at `/docs`) |

## Repo layout

```
apps/api            NestJS API (auth, identity, profile, wallet)
apps/wallet         Expo wallet client (web + iOS + Android)
apps/web            Public docs site (Fumadocs + Next.js)
contracts/svm       Pinocchio smart-account program (Rust)
contracts/evm       Counterfactual smart accounts (Solidity/Foundry)
packages/sdk-js     Browser SDK
packages/types      Shared TypeScript types
packages/openapi    OpenAPI 3.0 specification (source of truth)
```

## Quick start

Prereqs: Node.js 20+, pnpm, PostgreSQL 16+ (or Supabase), Solana toolchain 2.3.x for program work.

The local Postgres database is **`peridot_id`** (not `peridot` — that's the wider
ecosystem). `docker compose up -d` creates it; `DATABASE_URL` in `apps/api/.env`.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # add Google OAuth creds to test login
docker compose up -d                     # Postgres (optional; only if not using Supabase)
pnpm --filter @peridotvault/pid-api db:deploy
pnpm --filter @peridotvault/pid-api dev  # API on :3301
pnpm --filter @peridotvault/pid-web dev  # docs on :3300
pnpm --filter @peridotvault/pid-wallet dev:web  # wallet on :8081
```

Local chain: `cd contracts/svm && solana-test-validator --reset` (ledger stays
under `contracts/svm/`). Scripts: `pnpm test`, `pnpm typecheck`.

## SDK

```ts
import { Peridot } from '@peridotvault/pid-sdk-js';

const peridot = Peridot({
  baseUrl: 'https://api.pid.peridotvault.com',
  solanaRpcUrl: 'https://api.devnet.solana.com',
  onUnauthorized: async () => {
    const ok = await peridot.auth.refresh();
    if (!ok) await peridot.auth.login();
  },
});

await peridot.auth.login({ handle: 'ifal' }); // first sign-up claims ifal@pid
const me = await peridot.identity.me();       // { pid: 'ifal@pid', ... }
await peridot.profile.update({ displayName: 'PeridotPlayer' });
const rows = await peridot.wallet.createAccount(); // wallet chain rows
```

## Documentation

- [Docs site](https://pid.peridotvault.com) — getting started, authentication flow,
  API reference (generated from the OpenAPI spec), SDK guide, self-hosting/deployment.
- `docs/` — product spec (PRD_v5), architecture, database, security, roadmap, ADRs.
- `AGENTS.md` — agent run book (naming, environment, login split, verification).

## Deploy

See the [self-hosting guide](https://pid.peridotvault.com/docs/self-hosting). In short:
API + web/app on the VPS via `deploy/compose.yaml`; Postgres per the deploy guide.

## License

[MIT](LICENSE)
