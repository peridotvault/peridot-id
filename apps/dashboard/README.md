# `@peridotvault/pid-dashboard`

PeridotID developer dashboard — a **Vite + React** single-page app ported 1:1
from the former `apps/docs/app/workspace` (spec ANT-83; removed in ANT-124 when
`apps/docs` became the Mintlify source). Register apps, manage origins and
backend secrets, set per-app fees, and (admins) run the chain / contract /
partner / fee consoles.

**Private workspace package** — not published to npm.

## Scripts

| Script | Description |
|---|---|
| `dev` | `vite` dev server (browser on `:3303`) |
| `build` | `tsc -b && vite build` → `dist/` |
| `preview` | serve the production build on `:3303` |
| `typecheck` | `tsc -b` |

## Stack

- Vite 8 / React 19 / React Router 7 (flat routes, no nested layouts)
- Tailwind v4 via `@tailwindcss/vite` (theme tokens mirror `apps/docs`)
- `@peridotvault/pid-sdk-js` (all API calls — zero new endpoints)

## Local

```sh
pnpm --filter @peridotvault/pid-dashboard dev   # http://localhost:3303
# or from the repo root:
pnpm dev:dashboard
```

Point the SDK at a local API (`apps/api` on `:3300`, the default) and ensure
the wallet app (`apps/wallet` on `:3302`) is running — sign-in opens the
wallet popup for the first-party session.

## Env

| Var | Dev default | Prod |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3300` | `https://api.pid.peridotvault.com` |
| `VITE_POPUP_URL` (wallet popup host) | `http://localhost:3302` | `https://app.pid.peridotvault.com` (sandbox: `https://app.sandbox.pid.peridotvault.com`) |
| `VITE_PID_ENV` | unset (derived → `sandbox`) | `production` |
| `VITE_PID_CLIENT_ID` | unset (loopback needs none) | optional client_id for the `/demo` sample dapp |
| `VITE_OTHER_WORKSPACE_URL` (env-switch link) | unset | opposite-env dashboard URL |

LAN-safe: a configured loopback URL is host-swapped to the page host at
runtime (see `src/lib/api-base.ts`), so LAN devices work with zero env.
The env badge follows the *configured* URL, not the LAN-resolved one.

## Routes

| Route | Port source (historical — `apps/docs` is now the Mintlify source) |
|---|---|
| `/` (Apps + session gate) | `apps/docs/app/workspace/page.tsx` |
| `/apps/:id` | `apps/docs/app/workspace/apps/[id]/page.tsx` |
| `/chains`, `/chains/create`, `/chains/edit` | `…/chains/**` |
| `/contracts`, `/fees`, `/partners` | admin consoles |
| `/demo` | third-party sample dapp (popup only, no session) |

Admin tabs (Chains / Contracts / Partners / Fees) render only for
`role === "admin"`; other visitors see the "Admin only" guard, same as before.
Session scope stays `"web"` so existing workspace sessions remain valid.
