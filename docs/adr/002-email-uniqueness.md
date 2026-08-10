# ADR 002 — Email Uniqueness vs "Email Is Metadata"

Status: accepted

## Context

PRD V3 §4 ("Existing Identity Rules") states an email can only be associated with one PID,
and that a login whose email already belongs to another PID must be rejected — no merge, no
credential move, no second PID. PRD §16 (Definition of Done) requires "Email uniqueness rules
remain enforced."

The repository audit (task 001, `docs/ARCHITECTURE_AUDIT_V3.md`) demonstrated that the current
implementation differs:

- `docs/DATABASE.md`: "`email` is **metadata only**, not an identity."
- `schema.prisma`: `IdentityCredential.email` is nullable with no unique constraint or index;
  only `(provider, providerUserId)` is unique (`apps/api/prisma/schema.prisma:46-58`).
- `AuthService.upsertGoogleIdentity` (`apps/api/src/auth/auth.service.ts:38-73`) never looks up
  email: an unknown `(provider, providerUserId)` always creates a new identity, even when the
  Google email already belongs to another PID.

The PRD is the declared source of truth for V3 (`docs/tasks/README.md`). Per PRD §4, the rule
"MUST be preserved unless the repository audit demonstrates that the current implementation
differs and requires migration" — the audit found exactly that difference, so the divergence is
recorded here and reconciled.

## Decision

**Option A — enforce PRD §4.** An email is unique per PID. A Google login whose email is already
attached to a credential of a **different** PID is rejected:

- A generic `409 Conflict` is returned to the client. The message is Indonesian, per repository
  convention: `Email sudah terhubung dengan akun lain`.
- The message must not reveal which PID owns the email.
- No auto-merge, no credential move, no second PID.
- The user must explicitly resolve the existing identity association (out of V3 scope, per task
  002 out-of-scope note).

The same-credential happy path is unchanged: an existing `(google, providerUserId)` login
updates `lastLoginAt` and returns the existing identity.

### DB vs application enforcement

Both, as defense in depth:

1. **Application check** in `upsertGoogleIdentity` (task 004) — before creating a new identity,
   reject when the incoming email is non-null and already present on a credential of a different
   PID. This produces the friendly `409`.
2. **Database constraint** — a **partial unique index on non-null `email`**:
   `CREATE UNIQUE INDEX identity_credentials_email_key ON identity_credentials(email) WHERE email IS NOT NULL`.
   This is the authoritative guard against any future code path (or race) bypassing the
   application check. It is added as a raw SQL migration step because Prisma cannot express
   partial indexes in `schema.prisma`. NULL emails (providers that return no address) are
   unaffected.

### Client error

`409 Conflict` with a generic Indonesian message. Rationale: `409` is the correct semantic for a
state-conflict (the email already maps to a PID); the repository's API error convention is
Indonesian (`apps/api/src/identity/identity.service.ts:29,32`).

## Rejected alternative

**Option B — keep repository behavior (email stays metadata-only).** Rationale for rejection:

- It requires rewriting PRD §4 and §16 — a product-contract change that needs stakeholder
  sign-off and contradicts the declared source of truth.
- It leaves OAuth account confusion possible: a Google account whose email matches an existing
  PID can currently create a second PID, so email proves nothing about account ownership.
- Option A is the security-conservative choice: rejecting the collision is strictly less
  dangerous than silently minting a second account.

## Consequences

### Production data (duplicate emails)

Option A introduces a migration risk: production `identity_credentials` may already contain
duplicate non-null emails. Before the partial unique index is created (task 004), an audit must
run:

```sql
SELECT lower(email) AS email, count(*), array_agg(identity_id)
FROM identity_credentials
WHERE email IS NOT NULL
GROUP BY lower(email)
HAVING count(*) > 1;
```

Remediation for any collisions found is **not** automated merging (rejected by PRD §4).
Collisions are a product/operational call resolved per case before the constraint is added;
the constraint is only applied once zero duplicate non-null emails remain. Execution of this
audit and remediation is deferred to tasks 004/009; this ADR records the requirement.

### Definition of Done (PRD §16)

"DoD — Identity: Email uniqueness rules remain enforced" is satisfied by Option A: uniqueness
is enforced both in the login path and by the database constraint.

### Documentation

- `docs/DATABASE.md` is updated (email is no longer "metadata only"; a non-null email is unique
  across credentials).
- The docs-site statement "The **email is metadata only**"
  (`apps/docs/content/docs/(general)/authentication.mdx`) is corrected in task 009.

## Security considerations

- Google emails are **provider-verified** (requested via `scope: ["profile", "email"]`,
  `apps/api/src/auth/google.strategy.ts:20`). The rejection rule only extends to provider-verified
  emails. If a future provider supplies **unverified** emails, treating them identically would
  weaken Option A (an attacker could claim a victim's unverified email on their own provider
  account and trigger a false rejection). Future providers must prove email verification before
  their credentials join the uniqueness rule.
- Rejection must not leak which PID owns the email; the generic `409` message satisfies this.

## Migration considerations

- Only the DB-constraint variant (chosen above) has a migration. It requires the pre-migration
  audit above; it must be additive and safe to run with existing V2 rows once duplicates are
  remediated.
- No data backfill or identity changes are involved.

## References

- PRD V3 §4 (Existing Identity Rules — email uniqueness), §16 (Definition of Done).
- `docs/tasks/002-adr-email-uniqueness.md`, `docs/tasks/004-identity-email-collision-handling.md`.
- `docs/ARCHITECTURE_AUDIT_V3.md` §2, §4, §6.
- `apps/api/src/auth/auth.service.ts:38-73`, `apps/api/prisma/schema.prisma:46-58`,
  `docs/DATABASE.md`.

Blocks: task 004 (implementation).
