# 006 — API: Wallet Module (Retrieve + Create per ADR)

## Status

planned

## Objective

Add a NestJS `wallet` module exposing the minimum V3 wallet operations behind the existing
authentication boundary.

## Why

PRD §16 (Wallet): a wallet can be associated with a PID; ownership is a PID relationship;
retrieval works through the Peridot ID system; operations are authorized through the existing
session mechanism. The repo pattern to copy is `identity/` (thin controller + service +
Prisma, `JwtAuthGuard`, `@CurrentUser()`, REST under `/v1/`).

## PRD References

- §1 — V3 Goal (PID → Wallet)
- §3 — Fundamental Relationship (unlinking Google must not touch the wallet)
- §5 — Wallet Ownership
- §8 — Wallet Lifecycle (creation timing, retrieval, persistence)
- §10 — API/SDK (REST-first; follow existing conventions)

## Repository Context

- Pattern to follow: `apps/api/src/identity/{identity.module,controller,service}.ts`.
- Auth: `JwtAuthGuard` + `CurrentUser() → { identityId }` (`common/jwt-auth.guard.ts`,
  `common/current-user.decorator.ts`).
- Throttling: controllers sit behind `ThrottlerGuard` with per-route `@Throttle` where
  sensitive (`auth.controller.ts` is the example).
- Register the module in `app.module.ts`.

## Scope

- `apps/api/src/wallet/` module, controller, service — sized by the 003 ADR:
  - `GET /v1/wallet/me` — retrieve the authenticated PID's wallet (404/empty per ADR if none).
  - Wallet creation endpoint **only if** the ADR's creation timing is "explicit user action" or
    "lazy on first wallet operation" (e.g. `POST /v1/wallet`). If the ADR chose
    creation-at-signup/login, creation lives in the auth flow instead and this task adds the
    hook in `upsertGoogleIdentity`, not a public endpoint.
- Authorization: every wallet route requires `JwtAuthGuard`; the service resolves strictly by
  `identityId` from the token — never by a client-supplied PID or address.
- Response DTO contains only non-sensitive public fields per the ADR (address, chain, status,
  createdAt). No key material, ever (PRD §9).

## Out of Scope

- Signing transactions, balance queries, on-chain reads (not required by PRD V3 DoD).
- Wallet deletion endpoint (unless the 003 ADR explicitly defines one for V3).
- SDK/OpenAPI changes (task 007).

## Dependencies

- 003 (architecture + lifecycle), 005 (schema).

## Acceptance Criteria

- A wallet can be persisted for the correct PID via the ADR-chosen creation path.
- `GET /v1/wallet/me` returns the wallet association for the session's PID, and only that PID's.
- Unauthenticated requests are rejected (401); another PID's wallet is unreachable.
- Unlinking the Google credential (existing `DELETE /v1/identity/credentials/:id`) leaves the
  wallet row intact (PRD §3) — covered by a test.
- Existing identity constraints (provider uniqueness, last-credential guard) still enforced;
  `pnpm test` and `pnpm typecheck` pass.

## Testing Requirements

- Unit tests in the existing jest style (`auth.service.spec.ts` is the template): retrieval,
  creation per ADR timing, wrong-identity access, unlink-keeps-wallet regression.

## Security Considerations

- Strict token-derived ownership (no IDOR surface).
- Throttle the creation route (wallet creation may have cost/custody implications per ADR).
- Verify no sensitive field can appear in any response (PRD §9); if the custody ADR stores
  server-side material, use explicit `select` in Prisma queries.
