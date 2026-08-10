# 003 — ADR: Wallet Architecture, Custody & Lifecycle

## Status

planned

## Objective

Make and record the wallet architectural decisions the PRD deliberately leaves open, before any
wallet code or schema is written.

## Why

PRD §2.3/§6/§7 forbid assuming a wallet architecture, AA standard, custody model, key
management, blockchain, or third-party provider. The repository provides **zero evidence** for
any of these (no blockchain deps, no wallet code, V1 PRD lists blockchain as a non-goal, roadmap
mentions no chain). Per PRD §7, the correct move is to stop and document the decision — with
stakeholder input where the choice has custody/financial/irreversible consequences.

## PRD References

- §2.3 — Wallet (architecture must not be assumed)
- §5 — Wallet Ownership (wallet → PID, never → provider)
- §6 — Account Abstraction (investigate relevance; do not adopt by default)
- §7 — Blockchain Scope (document the decision rather than invent one)
- §8 — Wallet Lifecycle (creation, retrieval, persistence, deletion, PID deletion)
- §9 — Security Requirements
- §12 — Backward Compatibility (do not silently create wallets for existing users)

## Repository Context

Constraints the decision must respect:

- Deployment is **Vercel serverless** (`apps/api/vercel.json`) + Supabase Postgres — no
  persistent server process, no HSM, no Redis.
- Auth boundary available today: `JwtAuthGuard` → `AuthenticatedUser { identityId }`.
- DB cascade convention: `onDelete: Cascade` from `identities` to credentials/devices; PID
  deletion is soft-delete-by-field (`status`, `deletedAt`) with no endpoint yet.
- Stack is TypeScript-only; OpenAPI is the API source of truth.

## Scope

Write an ADR (e.g. `docs/adr/002-wallet-architecture.md`) deciding, with options and rationale:

1. **Blockchain scope** — which chain(s), or explicitly "undecided, stakeholder input required".
   Must not expand to multi-chain (PRD §7).
2. **Custody & key management** — e.g. server-generated keypair (keys in DB/KMS), third-party
   wallet infrastructure provider, client-held keys, or DB-record-only (address association
   without key custody). State where signing happens (server/client/none in V3).
3. **Account Abstraction** — whether AA is relevant at all for the chosen model; if not needed
   for V3, record that explicitly (PRD §6 permits "no").
4. **Creation timing** — signup / first login / explicit user action / lazy on first
   wallet-required operation (PRD §8 lists these; pick one with rationale).
5. **Lifecycle semantics** — retrieval, persistence guarantees (§8), whether wallet deletion is
   possible (and what it means if blockchain-backed), and what happens to the wallet on PID
   deletion (soft-delete only vs detach vs nothing — must be documented per §8).
6. **Existing users** — whether existing V2 identities get wallets (per §12, default should be
   "no silent creation") unless creation-timing choice makes it automatic and safe.

For each item: list the options considered, the chosen one, and consequences. Where the
repository genuinely cannot decide (chain choice, custody risk appetite), mark the item as
**requires stakeholder decision** with a concrete recommendation — do not invent one.

## Out of Scope

- Implementing anything (schema is task 005, API is task 006).
- Evaluating specific vendors beyond what is needed to make the custody decision.
- Multi-chain, session keys, paymasters, ERC-4337 specifics (PRD §6: possibilities, not
  requirements).

## Dependencies

None. Blocks 005 and 006.

## Acceptance Criteria

- ADR covers all six items above; each is either decided or explicitly escalated with a
  recommendation.
- The ADR states how wallet ↔ PID ownership is represented independently of Google (PRD §5).
- The ADR states the key-material exposure rule: nothing sensitive is ever returned by the API
  (PRD §9).
- Creation-timing choice makes clear whether existing V2 users are affected (PRD §12).

## Security Considerations

This task *is* the security fork: custody model determines key storage, signing location,
database-compromise blast radius, and account-takeover impact (§9). The ADR must include a
short threat paragraph per custody option considered.

## Migration Considerations

Records whether a backfill for existing users is required, permitted, or forbidden — input to
task 005.
