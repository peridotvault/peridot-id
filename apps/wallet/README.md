# `@peridotvault/pid-wallet`

PeridotID wallet client — a **Vite + React** web app (single-page) that
demonstrates the passkey-driven smart-account wallet on top of `@peridotvault/pid-sdk-js`.

EVM support status: passkey-owned counterfactual accounts are live on-chain, but
this wallet has no EVM permission/session-key UX yet — no session-key flows,
grant screens, or `v1/permissions` calls exist here. EVM permission UX is planned
follow-up work, not silently missing.

**Private workspace package** — not published to npm.

## Scripts

| Script | Description |
|---|---|
| `dev` | `vite` dev server (browser on `:3302`) |
| `dev:web` | alias of `dev` |
| `build` | `tsc -b && vite build` → `dist/` |
| `preview` | serve the production build on `:3302` |
| `typecheck` | `tsc -b` |

## Stack

- Vite 8 / React 19 (semantic DOM + `src/shared/styles.ts` helpers)
- `@peridotvault/pid-sdk-js`, `@peridotvault/pid-solana`, `@peridotvault/pid-types`

## Local

```sh
pnpm --filter @peridotvault/pid-wallet dev:web   # http://localhost:3302
```

Point the SDK at a local API (`apps/api` on `:3300`) — passkey origins
derive automatically from the wallet URL, nothing to configure.

## Login in dev (first-party contract)

This wallet is the **first-party** client: it talks to the API directly
(`@peridotvault/pid-sdk-js`) and uses the primitives in `@peridotvault/pid-core`
(hash payloads, WebAuthn ceremonies, key custody) via the SDK and
`@peridotvault/pid-solana`. It signs inline with an explicit passkey signer — this
origin IS the trusted DOM — and must **never** use the popup/hosted flow
(`popupBaseUrl`, `openLoginPopup`) reserved for third-party apps
(hosted login on `peridot.id`). CI enforces this split.

Dev and prod run the identical auth code paths — only credentials differ:

- **Passkey** works fully local against `http://localhost:3300` (open the wallet
  at exactly `http://localhost:3302`; the RP ID is `localhost`).
- **Google** needs a dev OAuth client: create one at
  https://console.cloud.google.com/apis/credentials with redirect URI
  `http://localhost:3300/v1/auth/google/callback`, fill in
  `GOOGLE_CLIENT_ID_DEV`/`GOOGLE_CLIENT_SECRET_DEV` in `apps/api/.env`, and
  restart the API. The prod client (prod callback only) lives in the deploy env.