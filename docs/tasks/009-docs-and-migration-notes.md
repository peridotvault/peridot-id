# 009 — Docs: Product Docs, Wallet Lifecycle & Migration Notes

## Status

done

## Objective

Bring all documentation in line with the shipped V3 behavior.

## Why

PRD §16 (Engineering): "Documentation is updated." PRD §8 requires the wallet lifecycle —
including PID deletion semantics — to be explicitly documented. PRD §12 requires the V2→V3
migration path to be documented.

## PRD References

- §8 — Wallet Lifecycle (must be explicitly documented, incl. PID deletion)
- §12 — Backward Compatibility (migration path must be documented)
- §16 — Definition of Done

## Repository Context

Docs that exist and are affected:

- `docs/DATABASE.md` — table list, ERD, invariants (needs `wallets` + outcome of ADR 002).
- `docs/API_SPEC.md`, `docs/SDK_SPEC.md` — endpoint/SDK lists (need wallet additions from 007).
- `docs/SECURITY.md` — short bullet list (needs the §9 dispositions from 008).
- `docs/ARCHITECTURE.md` — module list (needs `wallet`).
- `docs/ROADMAP.md` — wallet was not on it; V3 makes it current scope.
- `apps/docs/content/docs/` — public docs site (authentication.mdx, sdk.mdx, api reference is
  generated from `openapi.yaml`).

## Scope

- Update the files above to match implemented behavior — only what changed, in each file's
  existing terse style.
- Add the wallet lifecycle statement: creation timing (per 003), retrieval, persistence
  guarantees, deletion semantics, and **what happens to the wallet when a PID is deleted**
  (PRD §8 — explicit requirement).
- Add the migration note: `pnpm db:deploy` step, confirmation that V2 identities/credentials/
  sessions are untouched, and the backfill stance from the 003 ADR (expected: none — no silent
  wallet creation, PRD §12).
- Update the docs site pages that describe authentication/SDK where wallet behavior is
  user-visible.

## Out of Scope

- New guides or marketing content.
- Restructuring the docs site.

## Dependencies

- 006, 007 (documents implemented behavior, not plans). Incorporates outputs of 002, 003, 008.

## Acceptance Criteria

- Every doc claim matches the code (spot-check against routes/schema).
- PID-deletion → wallet behavior is written down explicitly (PRD §8 hard requirement).
- Migration note lets an operator deploy V3 with zero ambiguity (`db:deploy`, no data backfill
  unless the ADR says otherwise).
- `pnpm build` (docs site included) passes.

## Documentation Requirements

This task is the documentation deliverable.
