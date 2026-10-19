# `@peridotvault/pid-docs` — Mintlify source for docs.peridot.id

Mintlify docs source. The board user deploys this to Mintlify manually
(ANT-124 / board decision 2026-10-19): connect the `peridot-id` repo in
Mintlify, set the docs path to `apps/docs`, and attach custom
domains `docs.peridot.id` (prod) + `sandbox.docs.peridot.id` (sandbox)
via CNAME at Hostinger. Do NOT point docs hosts at the VPS — PR #20
deliberately does not route them; `docs.peridot.id` / `sandbox.docs.peridot.id`
are NXDOMAIN until the Mintlify CNAMEs land.

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
- Old hosts are documented as still-serving (dual-serve) wherever a new
  canonical `peridot.id` host is named. Code samples keep working as-is
  because the old API hosts stay live.

## The cutover (not yet — old docs still serve)

Until cutover, `apps/docs` (Fumadocs) keeps serving
`pid.peridotvault.com/docs*` untouched. At cutover, land a redirect on the
old docs service mapping `/docs/*` → the Mintlify host (strip the prefix):

| Old (serves today) | New (Mintlify, after user deploy) |
|---|---|
| `pid.peridotvault.com/docs` | `docs.peridot.id/` |
| `pid.peridotvault.com/docs/getting-started` | `docs.peridot.id/getting-started` |
| `pid.peridotvault.com/docs/api` | `docs.peridot.id/api/overview` |
| `sandbox.pid.peridotvault.com/docs*` | `sandbox.docs.peridot.id/*` (same mapping) |

Suggested implementation: `redirects()` in `apps/docs/next.config.mts` gated
by `NEXT_PUBLIC_MINTLIFY_DOCS_URL` (e.g. `https://docs.peridot.id`), so the
redirect only activates when the env var is set at build time. Do not enable
it before Mintlify serves both custom domains.

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

After the user deploys: old docs URLs still serve (same content as before)
AND new docs URLs serve the same content. Repro:

1. `GET https://pid.peridotvault.com/docs/getting-started` → 200, contains "Base URLs".
2. `GET https://docs.peridot.id/getting-started` → 200, same prose.
3. `GET https://docs.peridot.id/api/overview` → 200; an endpoint page
   generated from `openapi.yaml` (e.g. `POST /v1/auth/login`) renders.
4. Sandbox pair mirrors prod (`sandbox.pid.peridotvault.com/docs*` vs
   `sandbox.docs.peridot.id/*`).
