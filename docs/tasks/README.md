# V3 Task Plan — Peridot ID

Source of truth: `docs/prds/PRD_v3.md`. Generated after a full repository audit (2026-08-10).
Planning only — no implementation has started.

## Repository Audit Summary

**Stack:** pnpm monorepo. `apps/api` = NestJS 11 + Prisma 6 + PostgreSQL (Supabase), Passport
Google OAuth, JWT access cookie + rotating refresh cookie (state in `sessions` table),
`@nestjs/throttler`, Swagger, Vercel serverless. `packages/openapi` (openapi.yaml is the API
source of truth), `packages/types`, `packages/sdk-js` (browser fetch SDK), `apps/docs` (Fumadocs).

**REST-first, cookie-auth, no GraphQL. No blockchain/wallet code or dependencies anywhere
(zero hits for solana/web3/ethers/viem/wallet outside the PRDs). V1 PRD listed blockchain as an
explicit non-goal.**

### Requirement → Repository Matrix

| V3 Requirement | Repository Evidence | State | Required Change |
|---|---|---|---|
| PID identity, immutable | `Identity.id = pid_<ULID>` (`common/pid.ts`), `docs/DATABASE.md` | EXISTS | Preserve only |
| Provider uniqueness `(provider, providerUserId)` | `@@unique` in `schema.prisma`, migration `20260805045707` | EXISTS | Preserve only |
| Email uniqueness (one email = one PID, reject collision) | `docs/DATABASE.md`: "email is **metadata only**, not an identity"; `upsertGoogleIdentity` never checks email | **CONFLICTING** | Decision (002) + handling (004) |
| Google OAuth → PID → session | `auth/google.strategy.ts`, `auth.controller.ts`, `auth.service.ts` | EXISTS | Preserve only |
| Sessions (rotation, reuse rejection, revocation) | `sessions` table, `rotateSession`, refresh cookie path-scoped | EXISTS | Preserve only |
| Last-credential unlink guard | `IdentityService.unlinkCredential` rejects count ≤ 1 | EXISTS | Preserve + regression test with wallet present |
| Wallet associated with PID | Nothing — no table, module, dep, or doc | **MISSING** | Decision (003) → schema (005) → API (006) |
| Unlink Google keeps wallet | Unlink deletes only the credential row; wallet will hang off `identities` | Compatible by design | Verify via tests (006, 008) |
| Wallet lifecycle (create/retrieve/persist/delete) | No evidence anywhere | **MISSING** | Decision (003), document (009) |
| PID deletion | `status`/`deletedAt` fields exist; **no delete endpoint exists** | PARTIALLY_EXISTS | Define semantics in 003, document in 009 |
| API/SDK wallet surface | REST + OpenAPI + `PeridotClient` pattern established | MISSING (wallet part) | 007 (follow existing conventions) |
| Migration of V2 users | Wallet table is additive; no backfill decided yet | UNKNOWN pending 003 | 005 + migration notes in 009 |
| Security §9 (keys, signing, authz) | No key material exists today; env-based JWT secrets; throttling in place | N/A until 003 | 003 (decide) + 008 (verify) |

## Task Graph

```text
V3 Milestone
│
├── 001 Architecture audit report .................. P0  doc        deps: —
├── 002 ADR: email uniqueness reconciliation ....... P0  decision   deps: —
├── 003 ADR: wallet architecture & lifecycle ....... P0  decision   deps: —
│
├── 004 Identity: email-collision handling ......... P1  identity   deps: 002
│
├── 005 DB: wallets table migration ................ P1  database   deps: 003
├── 006 API: wallet module (create/retrieve) ....... P1  wallet     deps: 005, 003
├── 007 Contract: OpenAPI + types + SDK ............ P1  api/sdk    deps: 006
│
├── 008 Security: wallet authz & abuse tests ....... P1  security   deps: 006
│
└── 009 Docs: architecture, DB, API, SDK, migration  P2  docs       deps: 006, 007
```

Independent chains: `002 → 004` and `003 → 005 → 006 → 007 → 008` can run in parallel.
001 should be written first (PRD §13–14 require the audit artifact before coding).

## Tasks

| ID | Title | Category | Priority | Dependencies | PRD refs |
|---|---|---|---|---|---|
| 001 | V3 architecture audit report | doc | P0 | — | §13, §14 |
| 002 | ADR: email uniqueness vs "email is metadata" | decision | P0 | — | §4, §16 |
| 003 | ADR: wallet architecture, custody & lifecycle | decision | P0 | — | §2.3, §5–§9, §12 |
| 004 | Identity: credential email-collision handling | identity | P1 | 002 | §4, §16 |
| 005 | DB: `wallets` table + migration | database | P1 | 003 | §11, §12 |
| 006 | API: wallet module (retrieve + create per ADR) | wallet | P1 | 003, 005 | §1, §3, §5, §8, §10 |
| 007 | Contract: OpenAPI + types + SDK wallet support | api/sdk | P1 | 006 | §10, §16 |
| 008 | Security: wallet authorization & abuse-case tests | security | P1 | 006 | §9, §16 |
| 009 | Docs: update product docs + migration notes | docs | P2 | 006, 007 | §12, §16 |

## Conventions

- One file per task: `NNN-kebab-title.md`, status starts as `planned`.
- The repo is REST-first with `packages/openapi/src/openapi.yaml` as the API source of truth —
  no new transport style may be introduced (PRD §10).
- Existing API error messages are in Indonesian; follow that convention.
- No new dependency may be added without an ADR-level justification (PRD §15–16).
