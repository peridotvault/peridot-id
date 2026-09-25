# Database

Tables:

- `identities` — the PID. `pid` is `<handle>@pid` (e.g. `ifal@pid`), user-chosen once at
  onboarding; `status` is `active | suspended | deleted` (default `active`); `deletedAt`
  is set on soft delete. **The PID never changes, is never reused, and cannot be
  reassigned** — deleted rows keep their PK reserved. IDs are stored lowercase, so
  uniqueness is case-insensitive by construction. Every FK to an identity is a plain
  `pid` column (`pid_apps` uses `ownerPid`); the JWT `sub` claim carries it opaquely.
- `identity_credentials` — one row per way to log in (Google, Discord, Apple, email+password,
  passkey, ...). `(provider, providerUserId)` is unique — the source of truth. A non-null
  `email` is unique across all credentials (one email = one PID); see the email-uniqueness rule (ADR deleted; history in git).
- `profiles` — mutable labels only: `displayName`, `avatarUrl`, `locale`.
  Strict 1:1 with `identities` via shared primary key (`profiles.pid`).
  (The old surrogate `id` and `username`/`usernameChangedAt` columns were removed when
  the PID became the user-chosen handle; see migrations `20260913000000_*` and
  `20260913120000_pid_columns_and_chain_fk`.)
- `chain_accounts` — one row per chain account of the identity's personal wallet.
  `pid` FK → `identities.pid`; `chainId` FK → `chains.id`; `address` (PDA for
  `smart_account`, user-supplied for `linked_address`);
  `accountType ∈ {smart_account, linked_address}`.
  `@@unique([pid, chainId, accountType])` — one smart account per chain.
  **No key-material columns, ever.** (The old `pid_accounts` hub was removed;
  every wallet-owned row references the PID directly.)
- `authorities` — signing authorities for the wallet (secp256r1 passkeys). `pid` FK; `type`
  (`secp256r1` passkey for V1), `publicKey` (bytea), `credentialId` (WebAuthn), `status`.
  **Public material only** — the secret never leaves the client authenticator.
  (EVM V4 session keys are NOT stored here: they live in on-chain
  `sessions[permissionId]` records, granted/revoked by owner-signed transactions;
  the backend's grant validation is pure — no permission tables by design.)
- `wallet_fee_payers` — user-controlled fee payer. `chainAccountId` FK;
  `address` only — the key never leaves the client.
- `transactions` — `pid`, `chainAccountId`, `intentId` (nullable — deposits have no
  intent), `chain`, `network`, `txHash`, `status`, `confirmedAt`, `errorCode/Message`.
- `intents` — desired actions (PRD_v4 §5.4): `pid`, `type`, `payload` (jsonb), `status`,
  `expiresAt` (intent expiration, §22).
- `security_events` — audit log: `pid`, `eventType`, `metadata` (jsonb). Written by
  auth, credential, wallet, and program-facing flows. Never contains secrets.
- `devices` — one row per client device.
- `sessions` — rotating refresh-token state.

ERD:

```text
identities 1--* identity_credentials
identities 1--1 profiles
identities 1--* chain_accounts 1--* wallet_fee_payers
identities 1--* authorities
identities 1--* intents 1--* transactions *--1 chain_accounts
identities 1--* credential_challenges
identities 1--* security_events
identities 1--* devices 1--* sessions
identities 1--* pid_apps (via ownerPid)
identities 1--* fiat_provider_accounts
identities 1--* fiat_provider_transactions
identities 1--* fiat_ledger_entries
```

## Relation conventions

- Back-ref fields on `Identity` are Prisma-mandatory declarations (a relation
  needs both sides) and cost nothing at runtime. **Never `include` from
  `Identity`** — query the child delegate directly by `pid`
  (e.g. `prisma.fiatProviderAccount.findUnique(...)`).
- Journals are append-only: FK `onDelete: Restrict` (history must never vanish
  with the identity). Owned lifecycle rows (credentials, devices, chain
  accounts, authorities) use `Cascade`.
- Money movements lock the `identities` rows (`SELECT … FOR UPDATE`, PID-sorted)
  — no separate marker table (the deleted `internal_credit_accounts` taught us that).

Invariants:

- `(provider, providerUserId)` is unique.
- A non-null `email` is unique across `identity_credentials` (one email = one PID; enforced by
  a partial unique index plus the login-path check — email-uniqueness rule).
- An identity always keeps at least one credential (unlink of the last one is rejected).
- One identity owns exactly one personal wallet — wallet rows hang off
  `identities.pid` directly; there is no account hub table.
- EVM V4 permissions add scoped keys *inside* that one wallet
  (`sessions[permissionId]`: kind/target/caps/expiry/`seq`/revocation, ≤30d TTL)
  without new tables: persistence is the on-chain record; the backend computes
  ids/challenges purely (`POST /v1/permissions/grants/validate`). SVM sessions
  likewise add no tables: session PDAs live on-chain, validated via
  `POST /v1/session-keys/grants/validate` (WHITEPAPER.md §11). The `sessions`
  table below is cookie refresh-token state — unrelated to on-chain session keys.
- At most one `smart_account` chain account per chain (unique constraint);
  `linked_address` rows may coexist (legacy V3 records).
- The PID is the only source of truth — changing email, displayName, avatar, or linking/unlinking
  providers never changes the PID or the wallet.

## Wallet lifecycle

- **Creation** — explicit user action only. `POST /v1/account` ensures the Solana
  `smart_account` chain row (PDA derived from the PID) plus EVM counterfactuals.
  `POST /v1/wallet` records a user-supplied Solana address as a `linked_address`
  chain row (legacy V3 surface, deprecated). The smart account is created only by
  the user's first on-chain top-up (PRD_v5 §3). No silent creation, no backfill.
- **Retrieval** — `GET /v1/account` returns the wallet's chain rows (`404`
  when none). The `smart_account` address is deterministically resolvable before on-chain
  initialization (WHITEPAPER.md §1 seeds).
- **Persistence** — accounts hang off `identities`, so they survive OAuth provider changes,
  credential unlinking, logins from another device, and session expiration.
- **Deletion** — no wallet-deletion endpoint in V1. A DB delete cannot close an on-chain
  account; the program's `close` instruction is the only on-chain teardown and is not exposed
  by any V1 API.
- **PID deletion** — PID deletion is soft (`status = deleted`, `deletedAt`; no endpoint yet).
  Accounts soft-delete with the PID; an on-chain account has its own lifecycle and must not be
  silently destroyed by a DB delete.

## Migration (wallets → chain_accounts)

The `wallets` table (V3) was migrated into `chain_accounts` as
`account_type = 'linked_address'`, `chain_namespace = 'solana'`,
`chain_reference = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z'` (mainnet-beta genesis-hash prefix),
under each wallet-holding identity's default `pid_accounts` row. The migration verifies
the copy before dropping `wallets`. Smart-account creation is **not** backfilled — explicit
user action only.