# Documentation

Start with the [implementation plans](plan/README.md) for the approved identity,
external-wallet login, fiat access, embedded modal and usage-pricing direction.
Plans explicitly distinguish completed local work from unimplemented capabilities.

## Active references

| Document | Purpose |
|---|---|
| [Architecture](ARCHITECTURE.md) | System boundaries and repository layout |
| [Technology stack](TECH_STACK.md) | Current technologies; web wallet uses React + Vite |
| [Database](DATABASE.md) | Data model and identity invariants; verify against Prisma schema |
| [Security](SECURITY.md) | Authentication, wallet trust boundaries and incident guidance |
| [Fiat ledger](FIAT_LEDGER.md) | Active internal balance and accounting model |
| [App payments](FIAT_PAYMENTS.md) | Checkout, payment events and refunds |
| [Relying-party sessions](RP_SESSIONS.md) | App-backend session integration |
| [Live2Dev integration](LIVE2DEV_INTEGRATION.md) | Existing app-specific integration reference |
| [Smart wallet specification](prds/PRD_v5.md) | Wallet specification; current code and contract whitepaper settle implementation status |
| [Contract whitepaper](../contracts/WHITEPAPER.md) | Canonical smart-account contract specification |

## Operations

- [Chain registry](CHAIN_REGISTRY.md)
- [Relayer runbook](RELAYER_RUNBOOK.md)
- [Relayer dashboards](RELAYER_DASHBOARDS.md)
- [Payment provider operations — internal](PAYMENT_PROVIDER_OPERATIONS.md)
- [Retired hosts](RETIRED_HOSTS.md)
- [Security regression evidence](security/ant860-poc/README.md)
- [Additional contract security evidence](security/ant868-b4-v5.md)

These references are retained because they support operation, recovery or security;
cleanup does not certify every historical statement as current production behavior.

## Canonical developer documentation

- Public guides: [apps/docs](../apps/docs/README.md), including
  [SDK usage](../apps/docs/sdk.mdx) and [authentication](../apps/docs/authentication.mdx).
- API contract: [OpenAPI](../packages/openapi/src/openapi.yaml).
- SDK package: [SDK README](../packages/sdk-js/README.md).
- Local setup: [repository README](../README.md).
- Deployment: [deployment runbook](../deploy/README.md).

Do not maintain a second manual endpoint list or copy the SDK guide here.

## Historical material

Eight superseded or task-specific documents were moved to [archive](archive/README.md).
Their content remains available for traceability but is excluded from the active
reading list. New implementation plans belong in `docs/plan/` as `.md` files.
