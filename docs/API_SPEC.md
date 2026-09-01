# API

Source of truth: `packages/openapi/src/openapi.yaml` (served at `GET /v1/openapi.yaml`).

## Auth / Identity / Profile

POST /v1/auth/login · POST /v1/auth/logout · POST /v1/auth/refresh
GET /v1/auth/google · GET /v1/auth/google/callback
GET /v1/identity/me · GET /v1/identity/credentials · DELETE /v1/identity/credentials/:id
GET /v1/profile/me · PATCH /v1/profile

## Account (V4+)

POST /v1/accounts · GET /v1/accounts · GET /v1/accounts/:id · GET /v1/accounts/:id/chains

## Credentials (passkey authority, ADR 005 B)

GET /v1/credentials
POST /v1/credentials/register/start · POST /v1/credentials/register/finish
POST /v1/credentials/authenticate/start · POST /v1/credentials/authenticate/finish
DELETE /v1/credentials/:id

## Wallet

POST /v1/wallet/intents · GET /v1/wallet/intents/:id
POST /v1/wallet/transactions/submit · GET /v1/wallet/transactions/:id

Deprecated (V3 record-only): GET /v1/wallet/me · POST /v1/wallet

## Client

The SDK (`@peridotvault/pid-sdk-js`) wraps these:
`peridot.auth/identity/profile/passkey` and `peridot.wallet.{me,createAccount,topup,withdraw,getTransactionStatus,getBalance}`.