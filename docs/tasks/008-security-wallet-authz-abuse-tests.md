# 008 — Security: Wallet Authorization & Abuse-Case Tests

## Status

planned

## Objective

Verify the wallet implementation against the PRD §9 threat list with targeted tests and a short
written review, sized to the architecture chosen in task 003.

## Why

PRD §9: "Wallet functionality introduces significantly higher security requirements than
ordinary authentication" and §16 requires V3 behavior to have appropriate tests. The existing
security posture (rotating refresh tokens with reuse rejection, throttled auth routes, httpOnly
cookies) must not be weakened by wallet routes.

## PRD References

- §9 — Security Requirements
- §3 — Unlink must not detach wallet (abuse vector: unlink/relink attacks)
- §16 — Definition of Done (Wallet, Engineering)

## Repository Context

- Auth boundary: `JwtAuthGuard` validates token type + identity `status === "active"` per
  request (`jwt.strategy.ts`) — suspended/deleted PIDs are already rejected.
- Sessions: reuse of a rotated refresh token is rejected (`auth.service.ts` +
  `auth.service.spec.ts` "rejects a reused refresh token").
- No audit logging exists (`docs/SECURITY.md`: "Audit logs (future)") — do not build it here;
  note it as a follow-up if the custody ADR makes it necessary.

## Scope

1. **Abuse-case tests** (extend the existing jest specs), at minimum:
   - wallet routes reject expired/forged access tokens and tokens for suspended/deleted PIDs;
   - wallet retrieval for PID A never returns PID B's wallet (IDOR);
   - unlink-then-relogin flow: after unlinking Google (with a second credential present, per
     the existing guard), the wallet association persists unchanged (PRD §3);
   - wallet creation cannot be replayed/duplicated beyond the ADR's cardinality (e.g. second
     `POST` returns conflict or the existing wallet).
2. **Written security review** (a section in the 003 ADR file or `docs/SECURITY.md` update in
   009) walking the §9 list as it applies to the chosen architecture: key handling, signing
   location, auth→wallet authorization boundary, session abuse, replay, account/OAuth takeover,
   unlink/relink attacks, DB compromise, credential compromise, wallet compromise, recovery.
   Each item gets one line: mitigated-by-X / accepted-because-Y / open-follow-up.

## Out of Scope

- Pentesting, infra changes, audit-log infrastructure, KMS setup (implementation of the custody
  ADR's key handling belongs to 005/006; this task verifies it).
- Rate-limit redesign.

## Dependencies

- 006 (something to verify).

## Acceptance Criteria

- All listed abuse-case tests pass; `pnpm test` green including pre-existing specs.
- Every §9 bullet has a one-line disposition in the written review; none silently skipped.
- If any §9 item is unmitigated by the chosen architecture, it is recorded as an explicit open
  follow-up (with owner: stakeholder), not silently dropped.

## Security Considerations

This task is the security gate for V3 wallet work; DoD §16 (Wallet: "Sensitive wallet material
is protected", "operations are authorized") is verified here.

## Documentation Requirements

- The §9 disposition list lands in `docs/SECURITY.md` or the ADR (final placement decided in
  009).
