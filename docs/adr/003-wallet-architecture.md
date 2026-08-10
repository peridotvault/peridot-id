# ADR 003 — Wallet Architecture, Custody & Lifecycle

Status: accepted (with two escalations — future custody model, chain beyond the MVP)

## Context

PRD V3 §2.3/§6/§7 forbid assuming a wallet architecture, AA standard, custody model, key
management, blockchain, or third-party provider. The repository audit (task 001,
`docs/ARCHITECTURE_AUDIT_V3.md` §3) verified **zero wallet evidence**: no `wallet` model in
`schema.prisma`, no `solana|@solana|ethers|viem|web3` in `pnpm-lock.yaml`, no wallet code or
dependency in `apps/api` or `packages/*`, no wallet endpoint in `docs/API_SPEC.md`. V1 PRD lists
Wallet and Blockchain as explicit non-goals (`docs/prds/PRD.md` "Non-goals"); the roadmap names
no chain (`docs/ROADMAP.md`).

The audit therefore classified chain choice, custody & key management, AA relevance, creation
timing, lifecycle/PID-deletion semantics, and existing-user backfill as open decisions
(`docs/ARCHITECTURE_AUDIT_V3.md` §4 "Needs architectural decision", §7). Per PRD §7, these are
documented here rather than invented. The chain and custody-risk items carry financial and
irreversible consequences, so the **stakeholder (product owner) resolved them for the MVP**;
this ADR records both the original escalation and the resolution.

Constraints the decision must respect:

- **Deployment** is Vercel serverless (`apps/api/vercel.json`, framework `nestjs`) + Supabase
  PostgreSQL — no persistent server process, no HSM, no Redis (Postgres is the only datastore,
  `docs/ARCHITECTURE.md`; commit `0c11a47` dropped Redis).
- **Auth boundary** available today: `JwtAuthGuard` → `AuthenticatedUser { identityId }`
  (`apps/api/src/common/jwt-auth.guard.ts`, `apps/api/src/common/current-user.decorator.ts:3-5`).
  Wallet routes inherit it; ownership resolves strictly from the token.
- **DB cascade convention**: `identities → credentials/devices` use `onDelete: Cascade`
  (`apps/api/prisma/schema.prisma:34,49,63`). PID deletion is **soft-delete by field**
  (`status`, `deletedAt`; `schema.prisma:11-29`) with **no delete endpoint** (audit §2).
- **Stack** is TypeScript-only; OpenAPI is the API source of truth
  (`packages/openapi/src/openapi.yaml`).

## Decision

### 1. Blockchain scope — Solana for the V3 MVP, single chain

The repository provides no evidence for any chain, so the ADR was required to escalate rather
than invent one (PRD §7). The stakeholder resolved the escalation: **Solana is the V3 MVP
chain.** Multi-chain remains out of V3 (PRD §7: "Do not expand V3 into multi-chain wallet
support"); future EVM support is recorded as a roadmap possibility, **not** a V3 commitment and
**not** a schema- or API-level commitment.

Consequences:

- The wallet record carries `chain` (string) so a future chain can coexist without a migration
  of the association's shape — but V3 permits exactly one `chain` value (`solana`) per the
  creation path, and no multi-chain APIs are exposed.
- V3 performs **no on-chain operations**: no RPC reads, no balance queries, no transaction
  signing, no address verification (task 006 out of scope; PRD V3 DoD requires association, not
  chain interaction).
- Because `chain`/`address` are generic columns, the future EVM addition stays a product/roadmap
  item, not a schema or API change to plan now (YAGNI — no chain table, no chain registry).

### 2. Custody & key management — DB-record-only, no keys, no signing in V3

Options considered:

| Option | Where signing happens | Key storage | DB-compromise blast radius (threat paragraph) |
|---|---|---|---|
| **A. Server custody in DB** (generate keypair, keys encrypted in Postgres) | Server | Encrypted columns in Supabase Postgres | Worst. A DB compromise leaks (or lets an attacker decrypt) every wallet's key material → full account takeover of every PID. Requires new encryption-at-rest infra, key-rotation, and safe key-wrapping secrets on Vercel serverless — none of which exist (`apps/api/package.json` has no crypto/key-management deps). Rejected for V3. |
| **B. Server custody via external KMS/HSM** | Server | KMS-managed keys; app holds references | Good. Keys never touch the DB; compromise of the app or DB does not expose material. But requires a new vendor + account + SDK integration and contradicts "no new infrastructure without justification"; not viable before the custody decision lands. Deferred (see escalation below). |
| **C. Third-party wallet infrastructure provider** (MPC/wallet SaaS) | Provider | Provider-held shares | Depends entirely on the vendor's posture and contract; Peridot adds a data-privacy and availability dependency. PRD §2.3 says do not assume a third-party provider; vendor evaluation is out of task scope. Deferred. |
| **D. Client-held keys** (non-custodial, browser/mobile) | Client | User device | Peridot never touches keys — smallest server-side blast radius. But no signing client exists (SDK is a thin fetch client, `packages/sdk-js`), and it pushes a key-management/UX surface onto the client before any signing requirement exists. Deferred. |
| **E. DB-record-only, address association (chosen)** | **None in V3** | **None — no key material is generated, stored, or returned** | Negligible for the wallet: a DB compromise exposes an address string that grants no control over funds (the address owner signs elsewhere). Matches PRD §9 (nothing sensitive exposed) trivially. |

**Chosen for V3: Option E.** The wallet is an **address-association record on the PID**; Peridot
holds no private key material in any form in V3. **Signing location: none in V3.** This is the
only option that satisfies the V3 DoD (a wallet associated with a PID) with zero new security
infrastructure, no new dependency, and no weakening of the existing auth model (PRD §15: minimal
change, security over convenience).

**Address source.** Under record-only custody, the address must come from a source Peridot does
not control, so it is **user-supplied**: the user links a Solana address they own (`POST
/v1/wallet` accepts the address). Peridot generates no keys in V3 — this avoids both minting
unusable addresses (a generated keypair whose secret is discarded is a permanent trap) and
adding a crypto dependency for key generation. Consequence (accepted for V3): linking an address
proves **association only**, not on-chain ownership; see Security considerations. The user can
point Peridot at any address they control; the recorded association is what V3 persists and
returns.

**Escalation (future custody).** The moment V3 needs signing/on-chain interaction, Option E is
insufficient and a **custody model must be chosen by the stakeholder** (risk appetite is a
product decision, not a repo decision). Recommendation when that time comes: **Option B
(KMS-backed server custody) or Option C (provider) over Option A** — never plaintext keys in
Postgres on a serverless runtime. This ADR does not select one; task 008 records the §9
dispositions, and a follow-up ADR is required before any key material is introduced.

### 3. Account Abstraction — not relevant to V3, not adopted

PRD §6 explicitly permits "no". AA (smart accounts, ERC-4337, session keys, paymasters)
abstracts on-chain key/authorization ergonomics for accounts that sign. V3 does no signing and
has no on-chain authorization surface (Decision 2), so **AA solves no problem in V3**; adopting
it would be speculative infrastructure (PRD §15). Recorded explicitly so later phases do not
re-litigate: **AA is out of scope for V3, no AA dependency, no AA-specific API.** Revisit only
when a custody model and on-chain interaction exist.

### 4. Creation timing — explicit user action

PRD §8 lists four possibilities; PRD §12 forbids silent creation for existing users. Given
record-only custody (a wallet has no cost/security/on-chain implication) but an **undecided
custody model and a user-supplied address**, auto-creation at signup/first-login would mint an
empty association the user never asked for. **Chosen: explicit user action** — `POST /v1/wallet`
creates the wallet for the authenticated PID, recording the user-supplied address and
`chain = "solana"`.

Consequences:

- No wallet is created during signup or first login (no hook in
  `AuthService.upsertGoogleIdentity`, `apps/api/src/auth/auth.service.ts:38-73`).
- `POST /v1/wallet` is the single creation path; a second creation for the same PID returns the
  existing wallet (1 wallet per PID — see Ownership), matching task 008's cardinality test.
- Lazy-on-first-wallet-operation was rejected: V3 has no wallet-required operations, so it would
  never fire and the feature would be dead.
- Signup-time creation for **new** users becomes a clean option only once a custody model is
  decided; it is not offered in V3.

### 5. Lifecycle semantics

- **Retrieval.** `GET /v1/wallet/me` returns the authenticated PID's wallet (`chain`, `address`,
  `status`, `createdAt`); `404` when none exists (task 006). Resolution is strictly by
  `identityId` from the token — never a client-supplied PID or address (no IDOR surface).
- **Persistence guarantees (PRD §8).** The wallet hangs off `identities` (not credentials,
  devices, or sessions), so it survives: OAuth provider changes, credential unlinking,
  login from another device, session expiration/rotation, and normal account lifecycle
  operations. Unlinking the last-credential guard (`identity.service.ts:31-32`) deletes only the
  credential row; the wallet is untouched (PRD §3). "Unlink Google keeps wallet" is a task 006
  test.
- **Deletion.** **No wallet-deletion endpoint in V3.** The wallet is an association record with
  no on-chain or custody consequence, so deleting the row would be safe today — but PRD §8 says
  "Do not implement destructive wallet deletion merely because the database supports deleting a
  row," and V3 has no product need for it. If the wallet is ever backed by custody/signing, the
  ADR records that deletion then means *removing the association* — any on-chain account would
  have its own lifecycle and must not be silently destroyed by a DB delete.
- **PID deletion.** PID deletion is soft-delete-by-field (`status = deleted`, `deletedAt`), and
  **no delete endpoint exists** (`schema.prisma:11-29`). Because the wallet is a pure association
  in V3 with no independent on-chain lifecycle, it **soft-deletes with the PID** — same
  `status`/`deletedAt` convention, no detach, no hard cascade. (The FK uses `onDelete: Cascade`
  purely to match the existing convention; the only reachable path is soft-delete, so the
  cascade is defensive and never destructive.) Documented per PRD §8's explicit requirement;
  the on-chain-wallet-vs-identity-record lifecycle divergence is recorded for the future
  custody phase.

### 6. Existing users — no silent creation, no backfill

Because creation is explicit-user-action (Decision 4), **no existing V2 identity is affected**:
no wallet row is created for any PID until its user explicitly calls `POST /v1/wallet`. Per PRD
§12's default, **no backfill is required and none is permitted** without a future ADR deciding
otherwise (a backfill would mint associations the user never requested, and once a custody model
exists it could carry cost or custody implications). Migration (task 005) is a purely additive
`wallets` table; existing `identities`, `identity_credentials`, `profiles`, `devices`, `sessions`
rows are untouched.

## Ownership representation (PRD §5)

Wallet → PID, never wallet → Google. The relation is a `wallets.identityId` foreign key to
`identities.id` (the PID), `@unique` for **one wallet per PID**, `onDelete: Cascade` matching the
existing convention. The wallet record carries **no provider (Google) fields** — no
`provider`, `providerUserId`, or `email` (PRD §5, §11: "Do not duplicate provider information
inside wallet records"). Unlinking Google therefore cannot and does not touch the wallet; the
auth mechanism and the wallet evolve independently.

## Key-material exposure rule (PRD §9)

**Nothing sensitive is ever returned by the API.** In V3 this is structural: there is no key
material to expose (Decision 2). The wallet response DTO is limited to public fields — `id`,
`chain`, `address`, `status`, `createdAt` — and the OpenAPI/types/SDK contract (task 007) must
make any sensitive field structurally impossible (task 007 security note). Any future custody
model inherits the same rule: private keys and signing material never appear in responses,
never appear in logs, and are never selectable by default in Prisma queries.

## Rejected alternatives

- **Custody options A–D** (server-DB, KMS, provider, client-held) — rejected for V3 per the
  table in Decision 2: none can be adopted without new infrastructure, a vendor decision, or a
  client that does not exist, and all exceed V3's DoD. They remain the options for the escalated
  future custody decision.
- **Auto-creation at signup/first login** — rejected (Decision 4): mints unrequested
  associations and, until a custody model exists, has no address to populate meaningfully.
- **Lazy creation** — rejected (Decision 4): never fires in V3, dead feature.
- **AA adoption** — rejected (Decision 3): solves no V3 problem.
- **Multi-chain / EVM now** — rejected (PRD §7): single-chain Solana MVP; EVM recorded as
  roadmap.

## Consequences

### Schema (task 005)

`wallets` table: `id` (uuid), `identityId` (unique FK → `identities.id`, `onDelete: Cascade`),
`chain` (string, `"solana"` for V3), `address` (string, user-supplied), `status` (default
`active`; supports the soft-delete-with-PID convention), `createdAt`, `updatedAt`. **No
key-material columns** (never in V3; if a custody model later lands it requires a new migration
and a new ADR, not an ad-hoc column).

### API (task 006)

`GET /v1/wallet/me` (retrieve, 404 if none) and `POST /v1/wallet` (create, body = `{ address }`,
chain implied `solana` for V3). Both behind `JwtAuthGuard`; creation throttled per
`auth.controller.ts` convention. Second `POST` returns the existing wallet. Response DTO excludes
all sensitive material by construction.

### Existing-user stance

No V2 user gets a wallet; backfill forbidden without a future ADR. `docs/tasks/README.md`,
`docs/DATABASE.md`, and the docs site are updated in task 009.

## Security considerations

- **Threat paragraph per custody option** is given in the Decision 2 table. The governing
  context: Vercel serverless has no persistent process and no HSM; Supabase Postgres is the only
  datastore. Any server-side key storage on this stack is plaintext-at-rest-in-Postgres unless
  a KMS/provider is introduced — hence Option A's rejection and the escalation to B/C.
- **Record-only's accepted gap:** a linked address proves **association, not on-chain
  ownership** (no signature proof in V3). An attacker could link a victim's public address, or a
  user could link an address they do not control. Impact is limited to the association record
  (no funds, no signing, no on-chain operation in V3), so this is **accepted for V3** with an
  explicit **open follow-up (owner: stakeholder)**: once a custody/signing model lands, verify
  address ownership (e.g. signature challenge) before treating the association as authoritative.
- **No weakening of auth:** wallet routes reuse the existing cookie-JWT/session boundary; no new
  credential path is introduced (PRD §15: security over convenience).
- **Account takeover / unlink-relink:** wallet is gated on the same `JwtAuthGuard` and identity
  `status === "active"` checks as the rest of the API (`jwt.strategy.ts`); unlinking Google
  cannot touch the wallet (PRD §3). Each PRD §9 bullet has a one-line disposition in
  `docs/SECURITY.md` (final placement per task 009).
- **OAuth-provider verification** (ADR 002's email rule) is unaffected: wallet association never
  implies email or provider identity.

## Migration considerations

- **No data backfill** of wallets for existing users (Decision 6; PRD §12). The `wallets` table
  is additive and empty on deploy; V2 rows are untouched.
- Production path is the existing `pnpm db:deploy` flow against Supabase (task 005 documents the
  step; task 009 records the operator note).
- **No key material** exists anywhere in V3, so there is no key-migration or re-encryption step.
- The ADR's stance on backfill (required/permitted/forbidden): **forbidden without a future ADR**
  — recorded here as input to task 005.

## References

- PRD V3 §1, §2.3 (Wallet), §3 (Fundamental Relationship), §5 (Wallet Ownership), §6 (Account
  Abstraction), §7 (Blockchain Scope), §8 (Wallet Lifecycle), §9 (Security Requirements), §11
  (Database), §12 (Backward Compatibility), §15 (Implementation Principles), §16 (Definition of
  Done).
- `docs/ARCHITECTURE_AUDIT_V3.md` §3 (no wallet capability), §4, §5 (deferred items), §6
  (custody/operational risks), §7 (open decisions).
- `apps/api/prisma/schema.prisma:11-29,34,49,56,63`, `apps/api/vercel.json`,
  `apps/api/src/auth/auth.service.ts:38-73`, `apps/api/src/identity/identity.service.ts:31-32`,
  `apps/api/src/common/current-user.decorator.ts:3-5`,
  `apps/api/src/common/jwt-auth.guard.ts`.
- `docs/tasks/003-adr-wallet-architecture.md`, `docs/tasks/005-db-wallets-table.md`,
  `docs/tasks/006-api-wallet-module.md`, `docs/tasks/008-security-wallet-authz-abuse-tests.md`.

Blocks: task 005 (schema) and 006 (API).
