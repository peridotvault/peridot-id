# 004 — Identity: Credential Email-Collision Handling

## Status

done

## Objective

Implement the email-collision behavior decided in task 002 inside the Google login path.

## Why

Today `upsertGoogleIdentity` creates a new identity for any unknown Google credential without
looking at email. Whatever task 002 decides (enforce PRD §4 email uniqueness, or formally keep
email-as-metadata), the login path and docs must match the decision and be covered by tests.

## PRD References

- §4 — Existing Identity Rules (email uniqueness; no auto-merge, no auto-move, no second PID)
- §16 — Definition of Done (Identity, Authentication)

## Repository Context

- `apps/api/src/auth/auth.service.ts` — `upsertGoogleIdentity` is the single funnel for Google
  login/signup (both existing-login and create paths).
- `apps/api/src/auth/auth.service.spec.ts` — existing unit-test pattern with a prisma mock;
  extend it, do not introduce a new framework.
- Error messages in the API are in Indonesian — follow that convention.

## Scope

Exact change depends on 002's ADR:

- **If enforce (option A):** before creating a new identity in `upsertGoogleIdentity`, reject
  when the Google email is already attached to a credential of a different PID (409-style
  conflict error; no merge, no credential move, no second PID). Add the DB-level guard the ADR
  selected (e.g. partial unique index on non-null `email`) with its migration.
- **If keep metadata (option B):** no behavior change; add a regression test documenting that
  email is not an identity key, and update the DoD-relevant docs (folded into 009).

## Out of Scope

- Account merging, credential moving, or self-service identity resolution UI (rejected by PRD
  §4 for V3).
- Changes to unlink behavior.

## Dependencies

- 002 (ADR must exist first).

## Acceptance Criteria

- Behavior in `upsertGoogleIdentity` matches the 002 ADR exactly.
- If option A: login with an email owned by another PID is rejected with a clear error; no new
  identity is created; existing same-credential login still succeeds and bumps `lastLoginAt`.
- Provider uniqueness `(provider, providerUserId)` and PID immutability are untouched.
- Tests: new/updated cases in `auth.service.spec.ts` (and a migration test or note if a
  constraint was added); existing tests still pass (`pnpm test`).

## Testing Requirements

- Unit tests in the existing `auth.service.spec.ts` style covering the collision path and the
  happy paths (new signup, returning login).

## Security Considerations

- Rejection must not leak which PID owns the email (generic conflict message).
- Do not weaken the existing throttling on `/v1/auth/*`.

## Migration Considerations

- Only if option A with a DB constraint: the migration must follow the production-data
  remediation plan recorded in the 002 ADR (duplicate emails may already exist).
