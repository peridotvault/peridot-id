# 008 — Recovery & Multi-Device Flows

## Status

implemented (2026-08-28) — API-side recovery guarantees proven with a dedicated test suite.
Client orchestration lands in task 009; E2E in task 011.

## What is covered

The credential lifecycle API (task 003) provides the recovery primitives: multiple
passkeys per account, existing-credential approval for a second passkey, revocation, and
the last-credential guard. Task 008 adds the recovery/multi-device guarantees as explicit
tests (`credential.recovery.spec.ts`, 7 cases):

- multiple active credentials coexist (multi-device login);
- a second credential requires existing-credential approval;
- a revoked credential cannot approve adding another (abuse);
- revoking one credential keeps the wallet usable via the other (lost-device flow);
- revoking the last remaining credential is impossible (all-credentials-lost =
  unrecoverable — surfaced honestly, ADR 006 §5);
- a revoked credential disappears from the list and cannot authenticate;
- ownership (NotFound) is enforced from the token.

## Rotation (register → on-chain update → revoke)

Orchestrated client-side: register the new passkey (task 003) → the client signs
`update_authority` on-chain with the current passkey via the adapter (task 006) → revoke
the old credential (task 003). The program is the source of truth for the on-chain
authority; the API never knows it directly.

## Out of Scope

- Social recovery / guardians (PRD_v4 §31 future).
- Server-side key escrow of any kind (forbidden — ADR 006).
- Passkey platform-sync mechanics (handled by the platform, not Peridot).
- UX copy (second-credential prompt, all-credentials-lost warning) — task 010.

## Objective

Deliver PRD_v5 §6 multi-device + PRD_v4 §10 recovery: multiple passkeys per account,
revocation, rotation, an explicit new-device flow, and honest UX for the unrecoverable case.

## Why

PRD_v5 §6: one PeridotID account works on laptop, PC, and mobile from the same Google
login — but Google alone must never move assets. Recovery must be explicit, and a
compromised OAuth session must not be able to steal the wallet (PRD_v4 §10, §28
Recovery/Multi-Device).

## PRD References

- PRD_v5 §6 (multi-device); PRD_v4 §10 (multi-device & recovery), §22, §23.17 (recovery
  abuse), §28 (Recovery/Multi-Device)

## Repository Context

- 003 provides the credential lifecycle API; 004/006 provide on-chain `update_authority`.
- ADR 006 §5 defines the flows: revoke-with-surviving-credential, rotate (register → rotate
  on-chain → revoke old), and the documented V1 dead end (all credentials lost = no
  recovery; guardians deferred per PRD_v4 §31).
- Primary multi-device path is platform passkey sync (iCloud/Google) — handled by the
  platform, no Peridot machinery; this task builds the fallback: additional-credential
  registration with existing-credential approval.
- Error/copy language convention: Indonesian.

## Scope

- Rotation orchestration: register new credential (003) → on-chain `update_authority` via
  adapter (006) → revoke old credential; all-or-nothing semantics with explicit failure
  states (no half-rotated accounts without surfaced status).
- New-device flow: Google login → if a synced passkey exists, done → else register a new
  passkey approved by an existing credential on another device (ADR 006 §4).
- Lost-device flow: authenticate → list credentials → revoke lost device's credential →
  security event; require surviving-credential approval where ADR 006 §4 demands it.
- UX/SDK surfaces: second-credential prompt after wallet creation; credential list with
  last-used; the all-credentials-lost warning copy at registration time.
- Abuse tests: OAuth-session-only recovery attempt fails; revoked credential cannot
  authorize; rotated-out authority rejected on-chain (with 005's program tests).

## Out of Scope

- Social recovery / guardians (PRD_v4 §31 future).
- Server-side key escrow of any kind (forbidden — ADR 006).
- Passkey platform-sync mechanics (handled by the platform, not Peridot).

## Dependencies

- 003 (credentials), 004 + 006 (on-chain rotation path).

## Acceptance Criteria

- PRD_v4 §28 Recovery checkboxes all pass as tests: multiple credentials registerable;
  revocation works; rotation works end-to-end on devnet; new-device recovery via explicit
  flow; OAuth-alone never grants signing authority.
- Every flow emits `security_events` and is rate-limited.
- The unrecoverable case is documented in user-facing copy and `docs/SECURITY.md`.

## Security Considerations

- Recovery abuse (PRD_v4 §23.17) is the central threat: every recovery path requires an
  existing valid credential or is denied; there is no OAuth-only path by construction.
- Step-up semantics: rotation/revocation of the *last remaining* authority is impossible
  (003's guard + on-chain check).
