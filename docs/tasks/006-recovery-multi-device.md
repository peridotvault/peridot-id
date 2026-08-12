# 006 — Recovery & Multi-Device Flows

## Status

planned

## Objective

Deliver PRD_v4 §10's V1 recovery requirements: multiple credentials per account, revocation,
rotation, an explicit recovery flow, and honest UX for the unrecoverable case.

## Why

PRD_v4 §10: OAuth alone cannot recover a signing secret; recovery must be explicit, and a
compromised OAuth session must not be able to steal the wallet. §28 (Recovery/Multi-Device)
makes these acceptance criteria.

## PRD References

- §10 (multi-device & recovery), §22, §23.17 (recovery abuse), §28 (Recovery/Multi-Device),
  §29 Phase 3

## Repository Context

- 005 provides the credential lifecycle API; 007/010 provide on-chain `update_authority`.
- ADR 006 §5 defines the flows: revoke-with-surviving-credential, rotate (register → rotate
  on-chain → revoke old), and the documented V1 dead end (all credentials lost = no
  recovery; guardians deferred per PRD_v4 §31).
- Error/copy language convention: Indonesian.

## Scope

- Rotation orchestration: register new credential (005) → on-chain `update_authority` via
  adapter (010) → revoke old credential; all-or-nothing semantics with explicit failure
  states (no half-rotated accounts without surfaced status).
- Lost-device flow: authenticate → list credentials → revoke lost device's credential →
  security event; require surviving-credential approval where ADR 006 §4 demands it.
- UX/SDK surfaces: second-credential prompt after wallet creation; credential list with
  last-used; the all-credentials-lost warning copy at registration time.
- Abuse tests: OAuth-session-only recovery attempt fails; revoked credential cannot
  authorize; rotated-out authority rejected on-chain (with 008's program tests).

## Out of Scope

- Social recovery / guardians (PRD_v4 §31 future).
- Server-side key escrow of any kind (forbidden — ADR 006).
- Passkey platform-sync mechanics (handled by the platform, not Peridot).

## Dependencies

- 005 (credentials), 007 + 010 (on-chain rotation path).

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
  (005's guard + on-chain check).
