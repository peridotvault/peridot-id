# Database

Tables:

- `identities` — the PID. `id` is `pid_<ULID>`; `status` is `active | suspended | deleted`
  (default `active`); `deletedAt` is set on soft delete. **The PID never changes.**
- `identity_credentials` — one row per way to log in (Google, Discord, Apple, email+password,
  passkey, ...). `(provider, providerUserId)` is unique — the source of truth. A non-null
  `email` is unique across all credentials (one email = one PID); see
  `docs/adr/002-email-uniqueness.md`.
- `profiles` — `username` (unique, lowercase, `^[a-z0-9_]{3,20}$`), `usernameChangedAt`,
  `displayName`, `avatarUrl`, `locale`.
- `pid_accounts` — the wallet-owning entity (ADR 004). `identityId` FK → `identities.id`;
  `status` (soft-delete convention), `version`. V1 creates exactly one default account per
  identity; schema permits many (future multi-account).
- `chain_accounts` — one row per chain account. `accountId` FK → `pid_accounts.id`;
  CAIP-2 `chainNamespace`/`chainReference` (Solana V1); `address` (PDA for `smart_account`,
  user-supplied for `linked_address`); `accountType ∈ {smart_account, linked_address}`.
  `@@unique([accountId, chainNamespace, chainReference, accountType])` — one smart account
  per chain per account, while a migrated `linked_address` may coexist. **No key-material
  columns, ever.**
- `authorities` — signing authorities for an account (ADR 004/005). `type`
  (`secp256r1` passkey for V1), `publicKey` (bytea), `credentialId` (WebAuthn), `status`.
  **Public material only** — the secret never leaves the client authenticator.
- `wallet_fee_payers` — user-controlled fee payer (ADR 006). `chainAccountId` FK;
  `address` only — the key never leaves the client.
- `transactions` — `accountId`, `chainAccountId`, `intentId` (nullable — deposits have no
  intent), `chain`, `network`, `txHash`, `status`, `confirmedAt`, `errorCode/Message`.
- `intents` — desired actions (PRD_v4 §5.4): `type`, `payload` (jsonb), `status`,
  `expiresAt` (intent expiration, §22).
- `security_events` — audit log: `identityId`, nullable `accountId`, `eventType`,
  `metadata` (jsonb). Written by auth, credential, wallet, and program-facing flows.
  Never contains secrets.
- `devices` — one row per client device.
- `sessions` — rotating refresh-token state.

ERD:

```text
identities 1--* identity_credentials
identities 1--1 profiles
identities 1--* pid_accounts 1--* chain_accounts 1--* wallet_fee_payers
pid_accounts 1--* authorities
pid_accounts 1--* intents 1--* transactions *--1 chain_accounts
identities 1--* security_events *--1 pid_accounts
identities 1--* devices 1--* sessions
```

Invariants:

- `(provider, providerUserId)` is unique.
- A non-null `email` is unique across `identity_credentials` (one email = one PID; enforced by
  a partial unique index plus the login-path check — ADR 002).
- An identity always keeps at least one credential (unlink of the last one is rejected).
- V1: one default `pid_accounts` per identity (app-level; schema permits many).
- At most one `smart_account` chain account per account per chain (unique constraint);
  `linked_address` rows may coexist (legacy V3 records).
- The PID is the only source of truth — changing email, username, avatar, or linking/unlinking
  providers never changes the PID or the account/wallet.

## Wallet lifecycle (ADR 003/004)

- **Creation** — explicit user action only. `POST /v1/wallet` records a user-supplied Solana
  address as a `linked_address` chain account on the identity's default account (legacy V3
  surface, deprecated). The smart account is created only by the user's first on-chain
  top-up (PRD_v5 §3). No silent creation, no backfill.
- **Retrieval** — `GET /v1/wallet/me` returns the default account's `linked_address` (`404`
  when none). The `smart_account` address is deterministically resolvable before on-chain
  initialization (ADR 004 §5).
- **Persistence** — accounts hang off `identities`, so they survive OAuth provider changes,
  credential unlinking, logins from another device, and session expiration.
- **Deletion** — no wallet-deletion endpoint in V1. A DB delete cannot close an on-chain
  account; the program's `close` instruction is the only on-chain teardown and is not exposed
  by any V1 API (ADR 004).
- **PID deletion** — PID deletion is soft (`status = deleted`, `deletedAt`; no endpoint yet).
  Accounts soft-delete with the PID; an on-chain account has its own lifecycle and must not be
  silently destroyed by a DB delete.

## Migration (wallets → chain_accounts)

The `wallets` table (V3, ADR 003) was migrated into `chain_accounts` as
`account_type = 'linked_address'`, `chain_namespace = 'solana'`,
`chain_reference = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z'` (mainnet-beta genesis-hash prefix),
under each wallet-holding identity's default `pid_accounts` row. The migration verifies
the copy before dropping `wallets`. Smart-account creation is **not** backfilled — explicit
user action only (ADR 004 §4).