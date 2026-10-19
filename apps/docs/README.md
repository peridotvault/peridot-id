# `@peridotvault/pid-docs`

The public PeridotID documentation site — **Next.js + Fumadocs** (with `fumadocs-mdx`,
`fumadocs-openapi`, and Shiki). Serves getting-started, auth-flow, SDK, API-reference,
and self-hosting guides. Docs-only: no marketing pages, no workspace console, no
secrets — the dev console lives in `apps/dashboard` (backlog ANT-104).

**Private workspace package** — not published to npm.

## Scripts

| Script | Description |
|---|---|
| `dev` | `next dev -p 3301` |
| `build` | `next build` |
| `start` | `next start -p 3301` |
| `typecheck` | `tsc --noEmit` |

## Content

Docs live under `content/docs/`. The API reference is generated from
`@peridotvault/pid-openapi` via `fumadocs-openapi`. All `/docs/*` routes render here;
`/` redirects to `/docs`, and legacy `/workspace/*` URLs temporarily redirect to
`/docs` (see `next.config.mts`).

## Local

```sh
pnpm --filter @peridotvault/pid-docs dev   # http://localhost:3301
```

No env vars required.
