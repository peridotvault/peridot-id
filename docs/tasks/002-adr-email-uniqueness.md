# 002 — ADR: Email Uniqueness vs "Email Is Metadata"

## Status

planned

## Objective

Resolve the direct conflict between PRD V3 §4 (email uniqueness) and the repository's
documented identity model (email is metadata only) with an explicit, recorded decision.

## Why

PRD §4 states email uniqueness rules are "already established and MUST be preserved **unless
the repository audit demonstrates that the current implementation differs**" — and it differs:

- `docs/DATABASE.md`: "`email` is **metadata only**, not an identity."
- `schema.prisma`: no unique constraint or index on `identity_credentials.email`.
- `AuthService.upsertGoogleIdentity`: no email lookup; an unknown `(provider, providerUserId)`
  always creates a new identity, even if the Google email matches an existing credential.

Meanwhile PRD §16 (Definition of Done) requires "Email uniqueness rules remain enforced."
One side must win; guessing either way changes security and migration behavior.

## PRD References

- §4 — Existing Identity Rules (email uniqueness)
- §16 — Definition of Done (Identity)

## Repository Context

- `apps/api/src/auth/auth.service.ts` — `upsertGoogleIdentity` (lines 38–73)
- `apps/api/prisma/schema.prisma` — `IdentityCredential.email` (nullable, unconstrained)
- `docs/DATABASE.md` — invariants list

## Scope

Write a short ADR (e.g. `docs/adr/001-email-uniqueness.md` or a section in the audit report)
deciding one of:

- **A. Enforce PRD §4 as written:** email unique per PID; a Google login whose email belongs to
  another PID is rejected (no merge, no move, no second PID). Requires schema constraint or
  transactional check in `upsertGoogleIdentity`, plus production data audit for existing
  duplicate emails.
- **B. Keep repository behavior:** email stays metadata; update PRD understanding and DoD
  wording accordingly (product decision — may need stakeholder sign-off).

Also decide: whether uniqueness is enforced in the DB (partial unique index on non-null email)
or only in application logic, and what error the client receives on collision.

## Out of Scope

- Implementing the chosen behavior (that is task 004).
- Account merging or self-service identity resolution flows (not in V3 scope).

## Dependencies

None. Blocks task 004.

## Acceptance Criteria

- ADR exists, states the chosen option, and records the rejected alternative with rationale.
- The ADR explicitly addresses the production-data consequence (duplicate emails that may
  already exist under option A).
- `docs/DATABASE.md` and the DoD interpretation are updated to match the decision.

## Security Considerations

- Option A prevents a second PID being created for the same email (relevant to OAuth account
  confusion); option B keeps current behavior where email proves nothing. The ADR must note
  that Google emails are provider-verified but unverified emails from future providers would
  weaken option A if treated identically.

## Migration Considerations

- Option A only: audit existing `identity_credentials` for duplicate non-null emails before
  adding any constraint; define remediation for collisions found.
