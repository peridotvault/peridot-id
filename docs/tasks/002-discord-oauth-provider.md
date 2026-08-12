# 002 — Discord OAuth Provider + Security Events

## Status

planned

## Objective

Add Discord as a second OAuth provider behind the existing credential model, and emit
`security_events` for authentication and credential lifecycle actions.

## Why

PRD_v4 §1.1/§28 (Identity): Google login, Discord login, and an extensible provider
architecture. The repo already has Google via Passport (`auth/google.strategy.ts`) and the
`(provider, providerUserId)` credential model; Discord is a new strategy, not a new
architecture. Security events are required by PRD_v4 §5.1/§22 (audit log) and become the
audit backbone for credential/recovery flows (005/006).

## PRD References

- §1.1 (goals), §5.1 (Identity/Auth Service), §16 (Auth API), §22 (security requirements),
  §28 (Identity), §29 Phase 1

## Repository Context

- `apps/api/src/auth/` — Google strategy/controller/service; `upsertGoogleIdentity` pattern
  to generalize.
- `identity_credentials` table already provider-generic (`@@unique([provider, providerUserId])`).
- ADR 002 email-collision rule must apply to Discord identically (email verified or not —
  Discord emails are provider-verified; confirm verification flag before trusting `email`).
- Error messages are Indonesian; OpenAPI is the contract source of truth.

## Scope

- Passport Discord strategy + `/v1/auth/discord` start/callback endpoints (PRD_v4 §16 shape,
  following the existing Google route conventions).
- Generalize the upsert path to `upsertOAuthIdentity(provider, ...)` without changing Google
  behavior; ADR 002's 409 email-collision path reused.
- Write `security_events` rows for: login success/failure, credential linked/unlinked,
  session revoked (table arrives in 003; this task wires the emit points).
- OpenAPI + `packages/types` + `sdk-js` updates per contract-first convention.

## Out of Scope

- Additional providers beyond Discord (Apple/Steam/etc.).
- WebAuthn/passkey credentials (task 005).
- Account-linking UI flows beyond the API.

## Dependencies

- 001 (ADR 004 — `security_events` shape), 003 (security_events table).

## Acceptance Criteria

- Discord login creates/resolves the correct PID; `(discord, providerUserId)` uniqueness
  enforced; email collision returns the ADR 002 409 in Indonesian.
- PRD_v4 §22 auth checklist holds for Discord: state param, PKCE where applicable, HttpOnly
  SameSite cookies, token rotation unchanged.
- Security events queryable per identity.
- Existing Google E2E tests still pass; new Discord tests cover happy path + collision.

## Security Considerations

- OAuth provider account-linking protection (PRD_v4 §22): a Discord credential already bound
  to another PID must never be re-bound silently.
- Discord `email` is trusted only when Discord reports it verified.
