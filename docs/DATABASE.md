# Database

Tables:

- `identities` — the PID. `id` is `pid_<ULID>`; `status` is `active | suspended | deleted`
  (default `active`); `deletedAt` is set on soft delete. **The PID never changes.**
- `identity_credentials` — one row per way to log in (Google, Discord, Apple, email+password,
  passkey, ...). `(provider, providerUserId)` is unique — the source of truth. `email` is
  **metadata only**, not an identity.
- `profiles` — `username` (unique, lowercase, `^[a-z0-9_]{3,20}$`), `usernameChangedAt`,
  `displayName`, `avatarUrl`, `locale`.
- `devices` — one row per client device.
- `sessions` — rotating refresh-token state.

ERD:

```text
identities 1--* identity_credentials
identities 1--1 profiles
identities 1--* devices 1--* sessions
```

Invariants:

- `(provider, providerUserId)` is unique.
- An identity always keeps at least one credential (unlink of the last one is rejected).
- The PID is the only source of truth — changing email, username, avatar, or linking/unlinking
  providers never changes the PID.
