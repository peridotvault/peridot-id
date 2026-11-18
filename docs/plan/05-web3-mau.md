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

- **Counting unit:** a distinct active PID per app per UTC month. A PID is global
  and reusable: it counts once in App A and once in App B, but repeated logins or
  extra linked wallets never raise that app's monthly count.
- **Qualifying activity:** a successful *app-bound external-wallet login* for the
  Web3 number. Web2 login, cancelled/failed signatures, reads, fiat-only activity
  and passive provisioning never count toward it. Authorized Web3 operations are
  **not** metered for now.
- **Two figures, never blended:** total MAU (every app-bound login, Web2 or wallet)
  and qualifying Web3 MAU. The free allowance applies to Web3 MAU only — Web2-only
  usage is unlimited and free. Existing and newly claimed PIDs count identically.
- **Calendar boundary:** UTC calendar month (`YYYY-MM`), matching the stored key.
- **Free allowance:** 500 distinct active PIDs per app per month, configurable via
  `PID_USAGE_FREE_ALLOWANCE`.
- **Overage behaviour:** reporting only — the report shows the overage and the app
  keeps working. No charge, no warning gate, no cutoff.
- **Attribution points:** Web3 MAU is written where a wallet is verified for an
  app (login or claim). Total MAU is written when an app-bound SSO code is issued,
  which is the same moment the app receives the identity — an unverified app that
  only reaches the consent screen has not completed the login and is not counted.
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
