# Task Plan — Peridot ID

Source of truth: `docs/prds/PRD_v4.md` (implementation PRD). The Phase-0 architecture lock
lives in ADRs 004–007 (`docs/adr/`).

History: the completed V3 task set (identity + record-only wallet, old tasks 001–009) was
removed from this directory. Its decisions remain in ADRs 002–003 and in git history. What
V3 delivered and V4 builds on: Google OAuth → PID → session, email uniqueness (ADR 002),
and the record-only `wallets` table (migrated into V4's `chain_accounts` per ADR 004).

## Stack

pnpm monorepo. `apps/api` = NestJS 11 + Prisma 6 + PostgreSQL (Supabase), Passport Google
OAuth, JWT access cookie + rotating refresh cookie, `@nestjs/throttler`, Swagger, Vercel
serverless. `packages/openapi` (openapi.yaml is the API source of truth), `packages/types`,
`packages/sdk-js`, `apps/docs` (Fumadocs). REST-first, cookie-auth, no GraphQL.

V4 adds: `programs/peridot-smart-account` (Anchor/Rust) and `packages/solana` — the only
package allowed to import `@solana/web3.js` (ADR 007).

**Open gate:** ADR 005 (authority model: Ed25519 vs secp256r1 passkey) is `proposed` and
needs stakeholder sign-off. Until it lands, tasks 005 and 007 stay blocked (PRD_v4 §29/§32).

## Task Graph

```text
Milestone (PRD_v4)
│
├── 001 Architecture lock: ADRs 004–007 ............ P0  decision   deps: —
│
├── 003 DB: V4 account model migration ............. P0  database   deps: 001
├── 002 Discord OAuth + security events ............ P1  identity   deps: 001, 003
├── 004 Account service + API ...................... P1  account    deps: 003
│
├── 005 Credential registration & lifecycle API .... P1  crypto     deps: 001*, 003, 004
├── 006 Recovery & multi-device flows .............. P1  crypto     deps: 005, 007, 010
│
├── 007 Anchor smart account program ............... P1  program    deps: 001*
├── 008 Program tests + devnet deploy .............. P1  program    deps: 007
│
├── 010 Solana adapter + RPC abstraction ........... P1  solana     deps: 001, 007
├── 009 Intent & policy services ................... P1  wallet     deps: 003, 004, 010
├── 011 Wallet SDK + fee payer client .............. P1  sdk        deps: 004, 005, 009, 010
│
├── 012 E2E devnet transaction ..................... P0  e2e        deps: 002, 004–006, 008–011
│
└── 013 Production hardening (pre-mainnet) ......... P0  security   deps: 012
```

\* additionally blocked on the ADR 005 stakeholder decision.

Parallel tracks after 001+003: identity (002), program (007→008→010), and API
(004→005→006→009→011) converge at 012.

## Tasks

| ID | Title | Category | Priority | Dependencies | PRD_v4 refs |
|---|---|---|---|---|---|
| 001 | Architecture lock: ADRs 004–007 | decision | P0 | — | §7–§12, §29, §32 |
| 002 | Discord OAuth + security events | identity | P1 | 001, 003 | §5.1, §16, §22, §28 |
| 003 | DB: V4 account model migration | database | P0 | 001 | §9, §15, §28 |
| 004 | Account service + API | account | P1 | 003 | §5.2, §7.1, §16, §28 |
| 005 | Credential registration & lifecycle API | crypto | P1 | 001*, 003, 004 | §8–§10, §16, §28 |
| 006 | Recovery & multi-device flows | crypto | P1 | 005, 007, 010 | §10, §23, §28 |
| 007 | Anchor smart account program | program | P1 | 001* | §11, §24–§26 |
| 008 | Program tests + devnet deploy | program | P1 | 007 | §27, §28 |
| 009 | Intent & policy services | wallet | P1 | 003, 004, 010 | §5.4, §5.5, §25 |
| 010 | Solana adapter + RPC abstraction | solana | P1 | 001, 007 | §5.6, §13, §19 |
| 011 | Wallet SDK + fee payer client | sdk | P1 | 004, 005, 009, 010 | §8.3, §17, §30 |
| 012 | E2E devnet transaction | e2e | P0 | 002, 004–006, 008–011 | §27, §28, §30 |
| 013 | Production hardening (pre-mainnet) | security | P0 | 012 | §22–§24, §29 |

## ADRs

| ADR | Title | Status |
|---|---|---|
| 002 | Email uniqueness (V3) | accepted |
| 003 | Wallet architecture, custody & lifecycle (V3) | accepted — superseded by 004 for V4 |
| 004 | V4 account model (ACCOUNT_MODEL) | accepted |
| 005 | Signing authority model (AUTHORITY_MODEL) | **proposed — stakeholder decision required** |
| 006 | Wallet security & recovery model (WALLET_SECURITY_MODEL) | accepted |
| 007 | Solana program & chain adapter architecture | accepted |

## Conventions

- One file per task: `NNN-kebab-title.md`, status starts as `planned`.
- REST-first with `packages/openapi/src/openapi.yaml` as the API source of truth — no new
  transport style (PRD_v3 §10, still binding).
- Existing API error messages are in Indonesian; follow that convention.
- No new dependency without an ADR-level justification.
- PRD_v4 §32: never implement server-side key custody or mock authorization to make tests
  pass; unresolved security choices stop at the ADR, not at a code shortcut.
- Frontend components (PRD_v4 §18) are deferred until a consuming app (`apps/web`) exists —
  recorded in task 011.
