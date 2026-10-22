# `@peridotvault/pid-docs` — Mintlify source for docs.peridot.id

Mintlify docs source. The board user deploys this to Mintlify manually
(ANT-124 / board decision 2026-10-19): connect the `peridot-id` repo in
Mintlify, set the docs path to `apps/docs`, and attach the single custom
domain `docs.peridot.id` (no sandbox docs host)
via CNAME at Hostinger. Do NOT point the docs host at the VPS — PR #20
deliberately does not route it; `docs.peridot.id`
is NXDOMAIN until the Mintlify CNAME lands.

## Layout

```
apps/docs/
  docs.json            # Mintlify config (navigation, theme, API playground)
  index.mdx            # Overview (/)
  getting-started.mdx  # /getting-started
  environments.mdx     # /environments (prod vs sandbox hosts)
  self-hosting.mdx     # /self-hosting (incl. Mintlify deploy step)
  authentication.mdx sdk.mdx fiat.mdx apps.mdx
  sign-in-with-peridot-id.mdx embed-wallet.mdx errors.mdx
  api/overview.mdx     # /api/overview (API intro + base URLs)
  openapi.yaml         # synced copy of packages/openapi/src/openapi.yaml (Mintlify endpoint pages)
```

## Content rules

- Guides are converted 1:1 from the Fumadocs site (`apps/docs/content/docs`):
  same titles, same bodies. Internal links were rewritten from the old
  `/docs/*` prefix to Mintlify root paths (`/docs/getting-started` →
  `/getting-started`, `/docs/api` → `/api/overview`).
- `openapi.yaml` MUST stay byte-identical to
  `packages/openapi/src/openapi.yaml` (no schema change — origins only, if any,
  and those belong to the canonical spec first). Re-sync with:
  `cp packages/openapi/src/openapi.yaml apps/docs/openapi.yaml`.
- Old docs hosts are dead: the legacy `pid.peridotvault.com/docs*` and
  `sandbox.pid.peridotvault.com/docs*` paths no longer serve and do not
  redirect. Docs live only at `docs.peridot.id`.

## Docs location (hard cutover — no redirect)

Docs live ONLY at `docs.peridot.id`. The legacy
`pid.peridotvault.com/docs*` and `sandbox.pid.peridotvault.com/docs*`
paths are dead: they do not serve and do not redirect anywhere.
There is a single docs site for all environments — update any old
bookmarks to `docs.peridot.id` directly.

## Local preview / validation

```sh
npm i -g mint
cd apps/docs
mint dev              # preview at http://localhost:3000
mint validate         # docs.json + openapi.yaml validation
mint broken-links     # fix any reported link before pushing
```

A push to `paperclip` does not deploy docs — deployment happens only when
the board user clicks deploy/sync in Mintlify (manual).

## QA handoff (AC-15)

After the user deploys: docs serve ONLY at `docs.peridot.id`. The legacy
docs hosts are dead (connection refused / NXDOMAIN — no redirect). Repro:

1. `GET https://docs.peridot.id/getting-started` → 200, contains "Base URLs".
2. `GET https://docs.peridot.id/api/overview` → 200; an endpoint page
   generated from `openapi.yaml` (e.g. `POST /v1/auth/login`) renders.
3. `GET https://pid.peridotvault.com/docs/getting-started` → fails (dead host,
   no redirect). Same for the `sandbox.pid.peridotvault.com/docs*` paths.
