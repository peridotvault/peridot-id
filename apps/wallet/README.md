# `@peridotvault/pid-wallet`

PeridotID wallet client — an **Expo / React Native** app (web + iOS + Android) that
demonstrates the passkey-driven smart-account wallet on top of `@peridotvault/pid-sdk-js`.

**Private workspace package** — not published to npm.

## Scripts

| Script | Description |
|---|---|
| `dev` | `expo start` |
| `dev:web` | `expo start --web` (browser on `:8081`) |
| `typecheck` | `tsc -p tsconfig.json --noEmit` |

## Stack

- Expo SDK 57 / React Native 0.81 / React 19 (web via `react-native-web`)
- `@peridotvault/pid-sdk-js`, `@peridotvault/pid-solana`, `@peridotvault/pid-types`

## Local

```sh
pnpm --filter @peridotvault/pid-wallet dev:web   # http://localhost:8081
```

Point the SDK at a local API (`apps/api` on `:3301`) and ensure
`WEBAUTHN_ORIGINS` includes `http://localhost:8081` for passkey flows.

## Login in dev (first-party contract)

This wallet is the **first-party** client: it talks to the API directly
(`@peridotvault/pid-sdk-js`) and uses the primitives in `@peridotvault/pid-core`
(hash payloads, WebAuthn ceremonies, key custody) via the SDK and
`@peridotvault/pid-solana`. It must **never** import `@peridotvault/pid-react` —
that package is the public "Sign in with PeridotID" flow for third-party apps
(hosted login on `app.pid.peridotvault.com`, prod defaults). CI enforces this split.

Dev and prod run the identical auth code paths — only credentials differ:

- **Passkey** works fully local against `http://localhost:3301` (open the wallet
  at exactly `http://localhost:8081`; the RP ID is `localhost`).
- **Google** needs a dev OAuth client: create one at
  https://console.cloud.google.com/apis/credentials with redirect URI
  `http://localhost:3301/v1/auth/google/callback`, fill in
  `GOOGLE_CLIENT_ID_DEV`/`GOOGLE_CLIENT_SECRET_DEV` in `apps/api/.env`, and
  restart the API. The prod client (prod callback only) lives in the deploy env.