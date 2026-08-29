# Task Plan — PeridotID

Source of truth: `docs/prds/PRD_v5.md` (wallet product PRD) over the PRD_v4 architecture
base. All Phase-0 decisions are locked in ADRs 004–007 (all accepted).

History: this is the third task set. V3's set (identity + record-only wallet) shipped and
its decisions live in ADRs 002–003. The V4 set was replaced by this one after PRD_v5
resolved the open gates (ADR 005 = secp256r1 passkey, accepted; ADR 007 amended to
Pinocchio) and added the Expo client to V1 scope. Removed from scope: Discord OAuth
(post-V1, PRD_v5 §10). Old numbering is in git history; do not reference it.

## Stack

pnpm monorepo. `apps/api` = NestJS 11 + Prisma 6 + PostgreSQL (Supabase), Passport Google
OAuth, JWT access cookie + rotating refresh cookie, `@nestjs/throttler`, Swagger, Vercel
serverless. `packages/openapi` (openapi.yaml is the API source of truth), `packages/types`,
`packages/sdk-js`, `apps/docs` (Fumadocs). REST-first, cookie-auth, no GraphQL.

V5 adds: `programs/peridot-smart-account` (Pinocchio/Rust), `packages/solana` — the only
package allowed to import `@solana/web3.js` (ADR 007) — and `apps/wallet` (Expo: one
codebase for web + iOS + Android, PRD_v5 §9).

## Task Graph

```text
001 DB: account model migration .................. P0  database   deps: —
│
├── 002 Account service + API .................... P1  account    deps: 001
│   ├── 003 Passkey credentials API .............. P1  crypto     deps: 001, 002
│   │   └── 008 Recovery & multi-device .......... P1  crypto     deps: 003, 004, 006
│   └── 007 Intent & policy services ............. P1  wallet     deps: 001, 002, 006
│
├── 004 Smart account program (Pinocchio) ........ P1  program    deps: —
│   ├── 005 Program tests + devnet deploy ........ P1  program    deps: 004
│   └── 006 Solana adapter + RPC ................. P1  solana     deps: 004
│
├── 009 Wallet SDK + fee payer client ............ P1  sdk        deps: 002, 003, 006, 007
│   └── 010 Expo wallet client ................... P1  client     deps: 009
│
├── 011 E2E devnet transaction ................... P0  e2e        deps: 002,003,005–010
│
└── 012 Production hardening (pre-mainnet) ....... P0  security   deps: 011
```

Run order: **001 first** (everything API-side needs it) and **004 in parallel** (program
track needs nothing). Then the three tracks — API (002→003→007→008), program
(004→005→006), converge at 009 → 010 → 011 → 012.

## Tasks

| ID | Title | Category | Priority | Dependencies |
|---|---|---|---|---|
| 001 | DB: account model migration | database | P0 | — |
| 002 | Account service + API | account | P1 | 001 |
| 003 | Passkey credentials API | crypto | P1 | 001, 002 |
| 004 | Smart account program (Pinocchio) | program | P1 | — |
| 005 | Program tests + devnet deploy | program | P1 | 004 |
| 006 | Solana adapter + RPC abstraction | solana | P1 | 004 |
| 007 | Intent & policy services | wallet | P1 | 001, 002, 006 |
| 008 | Recovery & multi-device flows | crypto | P1 | 003, 004, 006 |
| 009 | Wallet SDK + fee payer client | sdk | P1 | 002, 003, 006, 007 |
| 010 | Expo wallet client (web+iOS+Android) | client | P1 | 009 |
| 011 | E2E devnet transaction | e2e | P0 | 002, 003, 005–010 |
| 012 | Production hardening (pre-mainnet) | security | P0 | 011 |

## ADRs

| ADR | Title | Status |
|---|---|---|
| 002 | Email uniqueness (V3) | accepted |
| 003 | Wallet architecture, custody & lifecycle (V3) | accepted — superseded by 004 for V4+ |
| 004 | V4 account model (ACCOUNT_MODEL) | accepted |
| 005 | Signing authority model (AUTHORITY_MODEL) | accepted — secp256r1 passkey (2026-08-27) |
| 006 | Wallet security & recovery model (WALLET_SECURITY_MODEL) | accepted |
| 007 | Solana program & chain adapter architecture | accepted — amended: Pinocchio (2026-08-27) |

## Conventions

- One file per task: `NNN-kebab-title.md`, status starts as `planned`.
- REST-first with `packages/openapi/src/openapi.yaml` as the API source of truth — no new
  transport style (PRD_v3 §10, still binding).
- Existing API error messages are in Indonesian; follow that convention.
- No new dependency without an ADR-level justification.
- PRD_v4 §32: never implement server-side key custody or mock authorization to make tests
  pass; unresolved security choices stop at the ADR, not at a code shortcut.
- UI components ship in the consuming Expo client (`apps/wallet`, task 010) per
  PRD_v5 §9 — one codebase for web + iOS + Android.
