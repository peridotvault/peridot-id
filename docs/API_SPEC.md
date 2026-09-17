# API

Source of truth: `packages/openapi/src/openapi.yaml` (served at `GET /v1/openapi.yaml`).

## Auth / Identity / Profile

POST /v1/auth/login (`handle` for first-time sign-up) · GET /v1/auth/pid/available?handle=
POST /v1/auth/passkey/start · POST /v1/auth/passkey/finish
POST /v1/auth/exchange · POST /v1/auth/authorize
POST /v1/auth/logout · POST /v1/auth/refresh
GET /v1/auth/google · GET /v1/auth/google/callback
GET /v1/auth/grants · DELETE /v1/auth/grants/:id
GET /v1/auth/sessions · DELETE /v1/auth/sessions/:id · DELETE /v1/auth/sessions/revoke-others
GET /v1/identity/me · GET /v1/identity/credentials · DELETE /v1/identity/credentials/:id · DELETE /v1/identity/me
GET /v1/profile/me · PATCH /v1/profile

## Account — the identity's personal wallet (ADR-008, singular routes)

POST /v1/account · GET /v1/account · GET /v1/account/chains
GET /v1/account/activation · POST /v1/account/activate
GET /v1/account/evm/:chainRef/activation · POST /v1/account/evm/:chainRef/activate

## Credentials (passkey authority, ADR 005 B)

GET /v1/credentials
POST /v1/credentials/register/start · POST /v1/credentials/register/finish
POST /v1/credentials/authenticate/start · POST /v1/credentials/authenticate/finish
DELETE /v1/credentials/:id

## Permissions (EVM scoped session keys, ADR 009)

POST /v1/permissions/grants/validate · GET /v1/permissions/denied-selectors

## Wallet

POST /v1/wallet/intents · GET /v1/wallet/intents/:id
POST /v1/wallet/transactions/submit · GET /v1/wallet/transactions/:id
POST /v1/wallet/withdraw/quote · POST /v1/wallet/withdraw

Deprecated (V3 record-only): GET /v1/wallet/me · POST /v1/wallet

## Apps (third-party "Sign in with PeridotID")

POST /v1/apps · GET /v1/apps · PATCH /v1/apps/:id · POST /v1/apps/:id/secret

## Admin (chain registry)

GET /v1/admin/chains · POST /v1/admin/chains · PATCH /v1/admin/chains/:id
POST /v1/admin/chains/:id/contracts

## Client

The SDK (`@peridotvault/pid-sdk-js`) wraps these:
`peridot.auth/identity/profile/passkey/grants` and `peridot.wallet.{me,createAccount,topup,withdraw,activate,activation,getBalance,tokens,history}`.
