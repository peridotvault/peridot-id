# 001 — V3 Architecture Audit Report

## Status

done

## Objective

Produce the audit artifact PRD V3 §14 requires before any implementation, capturing how the
current system actually works.

## Why

PRD §13–14 make the audit a hard gate before coding. The repository audit has already been
performed for this task plan; this task turns it into a permanent document so later agents do
not rediscover it.

## PRD References

- §13 — Repository Audit (required before coding)
- §14 — Audit Output (required sections)

## Repository Context

Audit basis (all verified 2026-08-10): `apps/api` (auth/identity/profile modules, Prisma schema,
migrations), `packages/{openapi,types,sdk-js}`, `docs/*.md`, git history (15 commits; key:
`72a69ff feat: v2 identity`, `0c11a47 drop Redis, add serverless handler`).

## Scope

Write `docs/ARCHITECTURE_AUDIT_V3.md` with exactly the PRD §14 sections:

1. **Current Architecture** — NestJS + Prisma + Postgres; cookie JWT; REST/OpenAPI-first.
2. **Existing Identity Model** — PID (`pid_<ULID>`, immutable), `identity_credentials`
   (`(provider, providerUserId)` unique, email = metadata only), username, unlink guard
   (last credential rejected), sessions (rotating refresh, reuse rejection, per-device rows).
3. **Existing Wallet Capability** — state explicitly: **none exists** (no code, no deps, no
   docs; V1 PRD lists blockchain as non-goal).
4. **V3 Gap Analysis** — reuse the Requirement → Repository Matrix from `docs/tasks/README.md`.
5. **Architecture Proposal** — smallest coherent architecture; fill in after tasks 002/003 are
   decided (or reference the ADRs).
6. **Risks** — security, migration, data-integrity, custody, authentication, operational.
7. **Open Decisions** — link to 002 and 003.

## Acceptance Criteria

- `docs/ARCHITECTURE_AUDIT_V3.md` exists with all seven PRD §14 sections.
- Every claim cites a repository path; nothing is asserted without evidence.
- Wallet capability is stated as non-existent, with the evidence (no deps/code) noted.

## Documentation Requirements

The file itself is the deliverable.
