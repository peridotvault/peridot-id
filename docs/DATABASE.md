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
- `wallets` — one row per wallet. `identityId` is unique (one wallet per PID) and is a foreign
  key to `identities.id` (`onDelete: Cascade`, defensive). Carries `chain` (Solana in V3) and a
  user-supplied `address`. **No key material is ever stored** (record-only custody) and there are
  no provider (Google) fields — see `docs/adr/003-wallet-architecture.md`.
- `devices` — one row per client device.
- `sessions` — rotating refresh-token state.

ERD:

```text
identities 1--* identity_credentials
identities 1--1 profiles
identities 1--1 wallets
identities 1--* devices 1--* sessions
```

Invariants:

- `(provider, providerUserId)` is unique.
- A non-null `email` is unique across `identity_credentials` (one email = one PID; enforced by
  a partial unique index plus the login-path check — ADR 002).
- An identity always keeps at least one credential (unlink of the last one is rejected).
- One wallet per PID (`identityId` unique); the wallet belongs to the PID, never to a provider.
- The PID is the only source of truth — changing email, username, avatar, or linking/unlinking
  providers never changes the PID or the wallet.

## Wallet lifecycle (ADR 003)

- **Creation** — explicit user action only: `POST /v1/wallet` records a user-supplied Solana
  address. No wallet is created at signup or login, and no wallet is silently created for
  existing users (PRD §12). A second `POST` returns the existing wallet.
- **Retrieval** — `GET /v1/wallet/me` returns the authenticated PID's wallet (`404` when none).
- **Persistence** — the wallet hangs off `identities`, so it survives OAuth provider changes,
  credential unlinking, logins from another device, and session expiration.
- **Deletion** — no wallet-deletion endpoint in V3. If a wallet is ever backed by custody or an
  on-chain account, deleting the row only removes the *association*; an on-chain wallet has its
  own lifecycle and must not be silently destroyed by a DB delete.
- **PID deletion** — PID deletion is soft (`status = deleted`, `deletedAt`; no endpoint yet).
  The wallet **soft-deletes with the PID** (same convention; no detach, no hard cascade). A
  future blockchain-backed wallet may have an on-chain lifecycle that outlives the identity
  record — documented here per PRD §8.
