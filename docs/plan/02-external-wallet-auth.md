# Stage 2: External wallet authentication and linking

Status: **Not implemented**.
Dependency: Stage 1; see [plan index](README.md).

## Scope and requirements

- Issue a random, short-lived, single-use server challenge bound to intended
  action (login/link), origin, app, chain namespace/network, and wallet address.
- Verify signatures server-side using the appropriate chain's signing format.
  Reject expired/replayed challenges, mismatched origin/app/address/network,
  invalid signatures, and disabled identities. Consume atomically.
- Link only with an authenticated PID session plus proof of the wallet. Enforce
  global credential uniqueness under concurrent requests. An address already
  linked elsewhere must never be silently reassigned or merged.
- Persist wallet auth methods accurately through claim, login, refresh and audit.
  Unlink must preserve a recovery/login method and require explicit confirmation.
- Tests cover successful and rejected signatures, replay, concurrent verification,
  account linking conflicts, recovery constraints, and existing login regressions.

## Implementation locations
`apps/api/src/auth`, `apps/api/src/identity`, `apps/api/src/credentials`,
`apps/api/prisma`, `packages/types`, and `packages/sdk-js/src/auth-client.ts`.

## Work items
- [ ] Define chain-aware credential identity and normalization (never lowercase Solana addresses).
- [ ] Add additive challenge storage, expiry, atomic consumption and uniqueness constraints.
- [ ] Implement server challenge/verify and authenticated link/unlink endpoints.
- [ ] Integrate PID claim, session rotation, auth method persistence and audit events.
- [ ] Add SDK types and methods; update canonical OpenAPI from implemented routes.
- [ ] Verify valid signatures, invalid/replayed signatures, concurrent requests and linking conflicts.
- [ ] Verify existing Google, email and passkey flows still work.

## Decisions before implementation
Specify message formats and supported chain/account types, including whether EVM
contract-wallet signatures are in scope. Phantom and MetaMask are initial clients;
credential identity must be chain/address based rather than extension-brand based.

## Rollout and rollback
Start disabled outside test environments. Use additive schema changes; disabling
new login must not delete linked credentials, identities or existing sessions.
Do not advertise support until API and connector integration tests pass.
