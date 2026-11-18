# Stage 3: Fiat access and replaceable payment backend

Status: **Not implemented**.
Dependency: Stage 2; see [plan index](README.md).

## Scope and requirements

Reuse the PID ledger. Do not open a separate fiat balance for each wallet address
or make fiat depend on provisioning an on-chain smart account. Define and enforce
applicable eligibility before enabling the new login method for fiat writes.
Maintain user/app token scope separation, transaction authorization, reconciliation,
idempotency and existing transfer restrictions.

Introduce a provider-neutral checkout interface at the existing injection seam.
Keep vendor-specific request signing, status mapping, notification parsing, and
credentials inside adapters. Switching an adapter must not alter public SDK shapes
or lose outstanding intents; reconciliation must retain original provider routing.
A renamed UI alone does not make the backend provider-interchangeable.

## Implementation locations
`apps/api/src/fiat`, `packages/payments`, `packages/sdk-js/src/fiat`,
`apps/wallet/src/pages/fiat`, and `apps/wallet/src/shared/app/fiatEnsure.ts`.

## Work items
- [ ] Specify applicable eligibility states, onboarding and fiat authorization requirements.
- [ ] Allow eligible wallet-authenticated PIDs to reuse their existing fiat balance.
- [ ] Remove any accidental requirement for on-chain account provisioning from fiat access.
- [ ] Introduce checkout adapter interface and normalized payment status/notification types.
- [ ] Store provider routing with intents so outstanding payments reconcile through their original adapter.
- [ ] Keep secrets and provider protocol details entirely behind the API.
- [ ] Test adapter behavior, exact amount matching, late payment, retry and duplicate notifications.
- [ ] Test authorization scopes, transfer restrictions, refund and insufficient-balance cases.

## Acceptance
The same PID sees the same balance regardless of login method. External assets are
untouched. Switching the backend adapter preserves public SDK contracts and
outstanding payment reconciliation. No new bank-withdrawal capability is implied.

## Rollout and rollback
Validate in payment test environments. Route new intents separately from existing
ones; rollback changes routing for new intents without rewriting historical ledger
entries. Enable fiat access only after eligibility requirements are implemented.
