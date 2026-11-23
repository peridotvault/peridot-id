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

- Vite 8 / React 19 / React Router 7 (workspace routes + one nested `/admin` layout)
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
| `VITE_API_URL` (mainnet API) | `http://localhost:3300` | `https://api.peridot.id` |
| `VITE_TEST_API_URL` | unset → same as `VITE_API_URL` | unset → derived `https://sandbox-api.peridot.id` |
| `VITE_POPUP_URL` (wallet host) | `http://localhost:3302` | `https://peridot.id` (one host for both networks) |
| `VITE_PID_CLIENT_ID` | unset (loopback needs none) | optional client_id for the `/demo` sample dapp |

The network is a user choice, not a build: a Mainnet/Testnet switch stores
`pid_network_mode` and reloads into that API (`?env=testnet` deep-links it).
The env badge follows the mode. Apps from both networks are listed together
with a badge; a detail route carries its own network (`/apps/:env/:id`).

LAN-safe: a configured loopback URL is host-swapped to the page host at
runtime (see `src/lib/api-base.ts`), so LAN devices work with zero env.
The env badge follows the selected network, not the URL.

## Routes

Workspace (topbar shell): `/` (Apps + session gate), `/apps/:env/:id`, `/demo`.

Every admin console lives under `/admin/*` behind `AdminLayout`
(`src/feat/admin/admin-layout.tsx`): session + `role === "admin"` gate, then a
sidebar shell. Non-admins and anonymous visitors get a gate screen; the API
(`AdminGuard`) is the authoritative check.

| Route | Page |
|---|---|
| `/admin` | redirect → `/admin/providers` |
| `/admin/providers` | provider list |
| `/admin/providers/new` | add a provider |
| `/admin/providers/:code` | one provider: display, availability, OAuth client, chain policy |
| `/admin/chain-families` | signing namespaces |
| `/admin/chains`, `/admin/chains/create` | chain registry |
| `/admin/chains/:id` | one chain: `general` (settings), `contracts`, `tokens` tabs |
| `/admin/fees` | fee consoles |
| `/admin/partners` | partner directory (verify apps) |
| `/admin/login-activity` | login history |
| `/admin/leveling` (+ `levels`, `tasks`, `history`, `settings`, `apps`) | progression admin |
| `/admin/settings` | system settings |

Old top-level admin URLs (`/chains`, `/fees`, `/leveling`, …) are gone and 404.
Admin tabs render only for `role === "admin"`. Session scope stays `"web"` so
existing workspace sessions remain valid.
