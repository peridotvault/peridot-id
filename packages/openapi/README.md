# `@peridotvault/pid-openapi`

The **source of truth** OpenAPI 3.0 specification for the PeridotID API. Consumed to
generate API reference docs (via `fumadocs-openapi` in `apps/docs`) and as a contract
for API consumers.

## Layout

```
src/openapi.yaml    OpenAPI 3.0 spec (single file)
```

## Preview locally

The API serves the spec at `GET /v1/openapi.yaml` with a Swagger UI at `/docs`.
Standalone validation:

```sh
npx @redocly/cli lint src/openapi.yaml
```

## Publishing

This is a static spec (no runtime code). Not published to npm currently — if you want it
distributed as an artifact, add `main`/`files` and set `publishConfig`:

```sh
pnpm --filter @peridotvault/pid-openapi publish --access public --no-git-checks
```

> Static spec with no `main`/`types` — publishable but with no runtime entry point.