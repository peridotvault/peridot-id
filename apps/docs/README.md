# `@peridotvault/pid-docs`

The public PeridotID documentation site — **Next.js + Fumadocs** (with `fumadocs-mdx`,
`fumadocs-openapi`, and Shiki). Serves getting-started, auth-flow, SDK, API-reference,
and self-hosting guides.

**Private workspace package** — not published to npm.

## Scripts

| Script | Description |
|---|---|
| `dev` | `next dev -p 3300` |
| `build` | `next build` |
| `start` | `next start -p 3300` |
| `typecheck` | `tsc --noEmit` |

## Content

Docs live under `content/docs/`. The API reference is generated from
`@peridotvault/pid-openapi` via `fumadocs-openapi`.

## Local

```sh
pnpm --filter @peridotvault/pid-docs dev   # http://localhost:3300
```