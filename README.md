# Peridot ID

Gaming Identity Platform — Authentication, Identity, and Profile for the Peridot ecosystem.
One Google sign-in, one stable identity, one profile across every Peridot product.

## Live URLs

| Service | URL |
|---|---|
| API | `https://api.peridot-id.peridotvault.com/v1` |
| Docs | `https://peridot-id.peridotvault.com` |
| OpenAPI spec | `GET /v1/openapi.yaml` (Swagger UI at `/docs`) |

## Repo layout

```
apps/api            NestJS API (auth, identity, profile) — serverless-ready for Vercel
apps/docs           Public docs site (Fumadocs + Next.js)
packages/sdk-js     Browser SDK
packages/types      Shared TypeScript types
packages/openapi    OpenAPI 3.0 specification (source of truth)
```

## Quick start

Prereqs: Node.js 20+, pnpm, PostgreSQL 16+ (or Supabase).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # add Google OAuth creds to test login
docker compose up -d                     # Postgres (optional; only if not using Supabase)
pnpm db:migrate
pnpm dev                                 # API on :3301, docs on :3300
```

Scripts: `pnpm dev`, `pnpm dev:api`, `pnpm dev:docs`, `pnpm build`, `pnpm test`, `pnpm typecheck`,
`pnpm db:migrate`.

## SDK

```ts
import { Peridot } from '@peridot/sdk-js';

const peridot = Peridot({
  baseUrl: 'https://api.peridot-id.peridotvault.com',
  onUnauthorized: async () => {
    const ok = await peridot.auth.refresh();
    if (!ok) await peridot.auth.login();
  },
});

await peridot.auth.login();                 // redirects to Google
const me = await peridot.identity.me();
await peridot.profile.update({ displayName: 'PeridotPlayer' });
```

## Documentation

- [Docs site](https://peridot-id.peridotvault.com) — getting started, authentication flow,
  API reference (generated from the OpenAPI spec), SDK guide, self-hosting/deployment.
- `docs/` — product docs (PRD, architecture, database, security, roadmap).

## Deploy

See the [self-hosting guide](https://peridot-id.peridotvault.com/docs/self-hosting). In short:
Supabase for Postgres, Vercel for the API (serverless) and the docs site.

## License

[MIT](LICENSE)
