# Identity, wallet access, and usage pricing

Approved direction: 2026-11-18. This document defines the target product contract.
It does not claim that planned capabilities are available in the current SDK.

## Product contract

- PeridotID is a universal PID identity layer with a web wallet and developer SDK.
  The current wallet is React + Vite; native iOS/Android applications are not shipped.
- Web2 OAuth login has unlimited free MAU. Request throttling and abuse controls
  remain independent of pricing. Email OTP and passkey are existing authentication
  methods; possession of a PID or automatic wallet provisioning is not Web3 usage.
- External wallet login initially targets Phantom (Solana) and MetaMask (EVM).
  Successful proof of wallet ownership authenticates a credential linked to one
  universal PID. An existing user explicitly links a wallet to their PID;
  a new user claims a PID after verification. Do not merge accounts implicitly.
- External private keys, recovery phrases, and assets remain in the external wallet.
  Signing a login message never transfers assets, approves spending, or makes the
  external wallet the authority of a PeridotID passkey smart account.
- A user authenticated through an external wallet can access the PeridotID fiat
  wallet attached to their PID, subject to applicable eligibility, onboarding,
  transaction authorization, limits, and operational availability. A wallet
  signature is proof of control, not identity verification for financial services.
- Developer login starts in an embedded UI modal. Wallet signature approval stays
  in the user's wallet. Provider authentication may still require its own browser
  interaction; do not promise that every authentication ceremony is popup-free.
- First-party login at peridot.id is free and excluded from billable app MAU.
- Usage is metered as distinct active PIDs per app per UTC calendar month: a PID
  counts once per app however many logins or linked wallets it uses, and the same
  PID counts separately in each app. Total MAU (all login methods) is tracked
  apart from qualifying Web3 MAU (a proved external wallet). The 500 free PIDs per
  app per month apply to Web3 MAU only; Web2-only usage is unlimited and free.
  Overage is reported only — paid rates and enforcement are still unspecified, so
  never charge or block at 501.
- Payment providers are backend implementation details. Product copy uses
  PeridotID Checkout, payment methods, gateway fees, and fiat balance. Applications
  use PeridotID contracts, not provider credentials or provider-specific SDK calls.

## Current implementation versus target

| Capability | Current evidence | Remaining work |
|---|---|---|
| Universal PID | Identity primary key and provider credential uniqueness | External wallet proof and linking lifecycle |
| Web2 login | Google OAuth, email OTP, passkey, sessions and SSO | Document free-MAU policy; protect it when metering is added |
| External login | Challenge/verify, Phantom + MetaMask connectors, claim/link/unlink, session `authMethod: wallet` | Provider authentication may still need its own browser interaction |
| Fiat | PID-scoped internal ledger, provider-neutral checkout adapter with per-intent routing, documented eligibility | Paid overage pricing only |
| Embed | iframe with hosted popup (unchanged) + `PeridotLoginModal` with Phantom/MetaMask signers, claim and link modes | — |
| App usage | `usage_events` + `usage_monthly` projection, UTC month dedupe, owner report, configurable allowance, dashboard card | Qualifying activity and rates need sign-off before billing |
| Provider replacement | `CheckoutAdapter` interface in `packages/payments`, DOKU behind it, persisted intent routing, contract tests | Add the next adapter when a second provider is chosen |

## Execution order

| Stage | Plan | Status |
|---|---|---|
| 1 | [Align product documentation and copy](01-product-documentation.md) | Prepared locally, not deployed |
| 2 | [External wallet authentication and linking](02-external-wallet-auth.md) | Implemented (API, SDK, OpenAPI) |
| 3 | [Fiat access and replaceable payment backend](03-fiat-and-payment-backend.md) | Implemented (adapter + routing, reporting-neutral) |
| 4 | [Embedded modal and SDK](04-embedded-login-sdk.md) | Implemented (modal + wallet connectors) |
| 5 | [Web3 usage reporting and free allowance](05-web3-mau.md) | Implemented as reporting only; counting rule agreed (total vs Web3 MAU), pricing open |

Complete and verify each stage before proceeding to its dependent stage. Each
plan owns its task checklist, acceptance criteria and rollout notes. These files
are plans, not evidence that functionality is shipped. Paid billing remains
pending the unresolved pricing decisions in stage 5.

## Documentation policy

Active implementation plans live in this directory as Markdown. Historical plans
and superseded references live in `../archive` and do not override this direction.
Operational and security references remain outside the plan directory.
