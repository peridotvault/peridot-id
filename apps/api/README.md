# `@peridotvault/pid-api`

PeridotID backend — a **NestJS** API handling authentication (Google OAuth + WebAuthn
passkey), identity, profile, non-custodial smart-account wallets (Solana + EVM),
and EVM permission grants. Serverless-ready
for Vercel.

**Private workspace package** — not published to npm.

## Scripts

| Script | Description |
|---|---|
| `dev` | `nest start --watch` (API on `:3301`) |
| `build` | `prisma generate && nest build` |
| `start` | `node dist/main.js` |
| `test` | `jest` |
| `typecheck` / `lint` | `tsc --noEmit` |
| `db:migrate` | `prisma migrate dev` |
| `db:deploy` | `prisma migrate deploy` |
| `db:generate` | `prisma generate` |
| `db:studio` | `prisma studio` |

## Environment

`DATABASE_URL` (Postgres **`peridot_id`**), `GOOGLE_CLIENT_ID_DEV`/`_SECRET_DEV`
(or `_PROD` when `NODE_ENV=production`),
`PID_PROGRAM_ID=CiwLJ1hMNjSRdZj2yMVt9BseRTjVd4pjz7Mxr9yXf6NT`, `WEBAUTHN_ORIGINS`,
`CLIENT_SUCCESS_URL`, `CORS_ORIGINS`. See `.env.example`.

## Modules

- `auth` — Google OAuth login, session cookies (`pid_access` / `pid_refresh`), refresh
- `identity` — identity + credentials management, passkey ceremony
- `profile` — profile read/update
- `wallet` / `account` — smart-account creation, intents, withdrawals
- `credentials` — WebAuthn registration/recovery, COSE parsing
- `permissions` — EVM V4 grant validation (`grants/validate`, `denied-selectors`;
  pure hygiene + canonical id/challenge, WHITEPAPER.md §10)
- `session-keys` — SVM session-grant validation (`grants/validate`, `constants`;
  pure hygiene + canonical address/challenge, WHITEPAPER.md §11)

## Test

```sh
pnpm --filter @peridotvault/pid-api exec jest   # 259 tests, incl. route authz
```