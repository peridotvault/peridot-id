# Stage 5: Web3 usage reporting and free allowance

Status: **Reporting implemented; counting rule agreed, rates still undefined**.
Dependency: Stage 4; see [plan index](README.md).

## Scope and requirements

Proposed counting rule for implementation: count a PID once per registered app per
UTC calendar month after a successful app-bound external-wallet authentication or
explicit authorized Web3 operation. Store the reason for counting. Web2 login,
failed/cancelled signatures, refresh, reads, faucet use, fiat-only payments, and
passive wallet provisioning do not count. Mixed login methods and multiple wallet
addresses for the same PID must deduplicate to the same app/month entry.

The activity definition and UTC month boundary are implementation proposals, not
previously agreed pricing details. Confirm these before enabling paid billing.
Record raw usage separately from billable usage and free allowance. Exempt
first-party activity by trusted server-side app classification, not a client flag
or absence of clientId. Unregistered app activity must not bypass attribution.
Make event insertion retry-safe, expose app-owner usage reports, and keep the
500 allowance configurable. Do not infer paid rates, automatic charges, or a hard
cutoff from this plan.

## Decisions (2026-11-18, agreed by the owner)

- **Qualifying activity:** a successful *app-bound external-wallet login* only.
  Web2 login, cancelled/failed signatures, reads, fiat-only activity and passive
  provisioning never count. Authorized Web3 operations are **not** metered for now.
- **Calendar boundary:** UTC calendar month (`YYYY-MM`), matching the stored key.
- **Free allowance:** 500 distinct active PIDs per app per month, configurable via
  `PID_USAGE_FREE_ALLOWANCE`.
- **Overage behaviour:** reporting only — the report shows the overage and the app
  keeps working. No charge, no warning gate, no cutoff.
- **Pricing:** deliberately undefined. Billing cannot be enabled until a rate and
  an enforcement policy are agreed; nothing in the code infers either.

## Implementation locations
`apps/api/prisma`, a dedicated API usage module, `apps/api/src/auth`,
`apps/dashboard`, `packages/types`, and SDK/documentation usage surfaces as needed.

## Work items
- [x] Finalize qualifying activity and calendar boundary before billing activation.
- [x] Add durable, idempotent server-authored usage events with app/PID attribution.
- [x] Add a unique app/PID/month projection and configurable free allowance (suggested 500).
- [x] Classify first-party apps on the server and exclude their login activity from billing.
- [x] Expose owner-scoped monthly usage and allowance reports in the dashboard.
- [x] Test retries, concurrent events, multiple wallets, mixed login methods and month boundaries.
- [x] Test that Web2-only, fiat-only and first-party login remain unbilled.
- [x] Keep paid billing disabled until rates and overage behavior are explicitly defined.

## Acceptance
One PID is counted at most once per app/month. The same PID may count separately
in two third-party apps. Reports distinguish total qualifying usage, free allowance
and potentially billable usage. Reaching 501 never invents a charge or hard block.

## Rollout and rollback
Run reporting-only first and reconcile against source events. Enable enforcement
only under an approved pricing policy. Disable enforcement without losing usage
history; retain replayable event attribution for corrections.
