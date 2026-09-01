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