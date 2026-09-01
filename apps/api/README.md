# `@peridotvault/pid-api`

PeridotID backend — a **NestJS** API handling authentication (Google OAuth + WebAuthn
passkey), identity, profile, and non-custodial Solana smart-account wallets. Serverless-ready
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

`DATABASE_URL` (Postgres **`peridot_id`**), `GOOGLE_CLIENT_ID`/`SECRET`,
`PID_PROGRAM_ID=G8tPCQRqZAg5R2TDGkcRKw8vZN3tJMdtyHGbaQhW5o4G`, `WEBAUTHN_ORIGINS`,
`CLIENT_SUCCESS_URL`, `CORS_ORIGINS`. See `.env.example`.

## Modules

- `auth` — Google OAuth login, session cookies (`pid_access` / `pid_refresh`), refresh
- `identity` — identity + credentials management, passkey ceremony
- `profile` — profile read/update
- `wallet` / `account` — smart-account creation, intents, withdrawals
- `credentials` — WebAuthn registration/recovery, COSE parsing

## Test

```sh
pnpm --filter @peridotvault/pid-api exec jest   # 83 tests
```