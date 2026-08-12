# ADR 004 — V4 Account Model: Identity → Peridot Account → Chain Account

Status: accepted

This ADR is the **ACCOUNT_MODEL.md** deliverable of PRD_v4 Phase 0 (§29). It supersedes the
record-only custody of ADR 003 for V4 and resolves ADR 003's documented escalation ("once a
custody model lands, a follow-up ADR is required").

## Context

PRD_v4 defines the target model: `users → peridot_accounts → chain_accounts`, plus
`authorities`, `wallet_fee_payers`, `transactions`, `intents`, `security_events`
(PRD_v4 §15), with the on-chain account being a Solana PDA smart account (§7). PRD_v4 §20
commands: adapt the recommended structure to the existing repository rather than blindly
replacing it.

Repository reality (audit, `docs/ARCHITECTURE_AUDIT_V3.md`; `apps/api/prisma/schema.prisma`):

- `identities` — the PID (`pid_<ULID>`), soft-delete by `status`/`deletedAt`. This **is**
  PRD_v4's `users` table.
- `identity_credentials` — `(provider, providerUserId)` unique, email uniqueness per ADR 002.
  This **is** PRD_v4's `oauth_identities`.
- `wallets` — ADR 003 record-only address association: `identityId @unique`, `chain`,
  `address`, no keys, one wallet per PID, user-supplied Solana address.
- Conventions: Prisma migrate, snake_case `@@map`, additive/data-preserving migrations,
  `onDelete: Cascade` from `identities` (defensive; only soft-delete is reachable).

The gap: PRD_v4 needs a programmable on-chain account (PDA) layered under a Peridot Account,
not a bare address record hanging off the identity.

## Decision

### 1. Table mapping — reuse, do not rename

| PRD_v4 table | Repository realization |
|---|---|
| `users` | existing `identities` (unchanged) |
| `oauth_identities` | existing `identity_credentials` (unchanged; ADR 002 rules hold) |
| `peridot_accounts` | **new** table |
| `chain_accounts` | **new** table; supersedes `wallets` (see §4) |
| `authorities` | **new** table |
| `wallet_fee_payers` | **new** table |
| `transactions` | **new** table |
| `intents` | **new** table |
| `security_events` | **new** table |

Renaming `identities`/`identity_credentials` to the PRD's names is rejected: pure churn
against every existing module, migration, and doc for zero semantic gain.

### 2. `peridot_accounts` — the wallet-owning entity

```text
id          uuid (PK)
identity_id FK → identities.id
status      active | suspended | deleted   (IdentityStatus enum, soft-delete convention)
version     int, default 1
created_at / updated_at
```

- Ownership chain is `chain_accounts → peridot_accounts → identities`. A chain account never
  references a credential or provider directly (PRD_v3 §5 preserved: wallet → PID, never
  wallet → Google).
- **V1 creates exactly one default account per identity** (app-level invariant; schema permits
  many so a future multi-account product needs no migration). Schema allows N; API exposes 1.

### 3. `chain_accounts` — one row per chain account

```text
id               uuid (PK)
account_id       FK → peridot_accounts.id
chain_namespace  string   -- CAIP-2 namespace: "solana" (V1), "eip155" (future)
chain_reference  string   -- CAIP-2 reference: genesis-hash prefix for Solana
address          string   -- PDA (smart_account) or user-supplied (linked_address)
account_type     string   -- "smart_account" | "linked_address"
status           active | suspended | deleted
created_at / updated_at
@@unique([account_id, chain_namespace, chain_reference, account_type])
```

- The unique constraint encodes **one smart account per chain per account** in V1, while
  permitting a migrated `linked_address` to coexist with the smart account on the same chain.
- CAIP-2 namespace/reference strings follow ADR 003's rationale (generic columns; future EVM
  is a product decision, not a schema change). Solana mainnet-beta reference is the
  genesis-hash prefix (`4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z`), per PRD_v4 §15.
- No chain registry table, no token tables (YAGNI).

### 4. `wallets` (V3) → `chain_accounts` migration

- Every existing `wallets` row is migrated to `chain_accounts` with
  `account_type = "linked_address"`, `chain_namespace = "solana"`, under the identity's
  default `peridot_accounts` row (created during the migration for identities that hold a
  wallet). No row is dropped; the migration is data-preserving per repo convention.
- A V3 linked address is **not** a smart account and is never promoted to one. It remains a
  record-only association with ADR 003's accepted limitation (association ≠ on-chain
  ownership). PRD_v4 transaction flows operate **only** on `smart_account` rows.
- The `wallets` table is dropped in the same migration after data is copied (the V3 API
  surface is preserved — see Consequences). If the copy verification fails, the migration
  aborts before the drop.
- **No smart-account backfill**: existing users get a `peridot_accounts` default row only;
  smart-account initialization remains an explicit user action (extends ADR 003 Decision 4/6,
  PRD_v3 §12 — no silent creation, now with real on-chain cost).

### 5. Smart account identity — PDA derivation

- On-chain account = PDA of the Peridot program (ADR 007) with seeds
  `["peridot", "account", account_id]` where `account_id` is the 32-byte representation of the
  `peridot_accounts.id` row (UUID bytes, zero-padded derivation documented in task 004).
- Therefore the smart-account `address` is **deterministically resolvable** off-chain before
  any on-chain initialization (PRD_v4 §28 Wallet: "deterministically resolvable") — the API
  can return the address before the program account exists; `status`/`deployment` tracking
  distinguishes derived vs initialized.
- `chain_accounts` gains no key-material columns, ever (ADR 003 key-exposure rule carried
  verbatim; PRD_v4 §9).

### 6. Supporting tables (per PRD_v4 §15, adapted)

- `authorities`: `id`, `account_id` FK, `type` (`ed25519` | `secp256r1`, per ADR 005),
  `public_key` (bytea), `credential_id` (nullable — WebAuthn credential id when type is
  secp256r1), `status`, `created_at`, `last_used_at`. 1:N per account (PRD_v4 §10:
  multiple credentials). **Public material only.**
- `wallet_fee_payers`: `id`, `chain_account_id` FK, `address`, `status`, `created_at`.
  Records the user-controlled fee payer's **address only**; the key never leaves the client
  (ADR 006).
- `transactions`: `id`, `account_id`, `chain_account_id`, `intent_id`, `chain`, `network`,
  `tx_hash`, `status`, `created_at`, `confirmed_at`, `error_code`, `error_message`.
- `intents`: `id`, `account_id`, `type`, `payload` (jsonb), `status`, `created_at`,
  `expires_at` (PRD_v4 §22: intent expiration).
- `security_events`: `id`, `identity_id` FK, `account_id` nullable, `event_type`,
  `metadata` (jsonb), `created_at`. Written by auth, credentials, wallet, and program-facing
  flows (PRD_v4 §5.1, §22 audit logs).

## Rejected alternatives

- **Rename existing tables to PRD names** — rejected (§1): churn without semantic gain.
- **Bolt smart-account columns onto `wallets`** — rejected: mixes record-only and programmable
  custody semantics in one row; the V3/V4 lifecycle rules differ (ADR 003 PID-deletion
  soft-delete vs on-chain PDA that a DB delete cannot close).
- **Merge `peridot_accounts` into `identities`** — rejected: breaks PRD_v4's layering and
  pre-commits against multi-account futures the schema already cheaply permits.
- **Keep `wallets` as a parallel permanent table** — rejected: two sources of truth for
  "user's Solana address association"; migrated into `chain_accounts` instead.
- **Chain registry table** — rejected (YAGNI), same as ADR 003.

## Consequences

### Schema (task 003)

New Prisma models per §2/§3/§6 with repo conventions (`@@map`, `onDelete: Cascade` from
`identities` → `peridot_accounts` → `chain_accounts` as defensive cascades; only soft-delete
is reachable). Data migration for `wallets` per §4. `pnpm db:generate` + `typecheck` must
pass; migration must apply on a database containing live V2/V3 data.

### API (task 004)

PRD_v4 §16 account surface: `POST /accounts`, `GET /accounts`, `GET /accounts/:id`,
`GET /accounts/:id/chains`. The V3 `GET /v1/wallet/me` / `POST /v1/wallet` keep working for
existing clients, backed by `linked_address` rows on the default account; they are marked
deprecated in OpenAPI and never return `smart_account` rows.

### Lifecycle

- Wallet persistence guarantees of ADR 003 carry over unchanged (hangs off the identity
  lineage, survives provider unlink/session rotation/device change).
- PID deletion: soft-delete cascades down `peridot_accounts`/`chain_accounts` by `status`,
  same as today. **Documented divergence (PRD_v3 §8):** a DB delete cannot close the on-chain
  PDA; the program's `close` instruction (ADR 007) is the only on-chain teardown and is not
  exposed by any V1 API.
- No wallet-deletion endpoint in V1 (carried from ADR 003, now stronger: deleting the row
  would orphan an on-chain account).

## Security considerations

- **Database compromise blast radius (PRD_v4 §23):** the new tables hold addresses, public
  keys, credential IDs, and metadata only — no column grants signing capability. A full DB
  dump cannot move funds; on-chain authorization is cryptographic (ADR 005, ADR 007).
- `authorities.public_key`/`credential_id` are public by definition (WebAuthn authenticator
  data, Ed25519 pubkey); storing them server-side is PRD_v4 §9 "Allowed".
- The `linked_address` association-vs-ownership gap from ADR 003 remains confined to
  record-only reads; transaction flows require `smart_account` rows whose authority is
  verified on-chain, closing the gap for anything that moves value.
- Ownership resolution on all new endpoints is strictly from the token's `identityId`
  (existing `JwtAuthGuard`), never a client-supplied account id — no IDOR surface (task 004).

## Migration considerations

- Single additive-then-copy-then-drop migration (task 003): create new tables → create default
  `peridot_accounts` for wallet-holding identities → copy `wallets` → verify counts → drop
  `wallets`. Production path: existing `pnpm db:deploy` against Supabase.
- Backfill stance: `wallets → chain_accounts` copy **required**; smart-account creation
  backfill **forbidden** (explicit user action only).
- No key material exists or is introduced, so no re-encryption or key-migration step.

## References

- PRD_v4 §2, §5.2, §6, §7, §9, §10, §15, §16, §20, §22, §23, §28 (Wallet), §29 Phase 0/2.
- PRD_v3 §3, §5, §8, §11, §12 (carried fundamentals).
- ADR 002 (email uniqueness), ADR 003 (record-only custody being superseded; escalation
  resolved here).
- `apps/api/prisma/schema.prisma`, `docs/ARCHITECTURE_AUDIT_V3.md` §3–§7.

Blocks: tasks 003 (schema), 004 (account API).
