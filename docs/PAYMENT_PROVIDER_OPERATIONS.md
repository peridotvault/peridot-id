# Payment provider operations (internal)

Implementation-specific deployment configuration for the current adapter.
This is not the public product contract. Keep runtime identifiers accurate when
rotating providers; changing UI wording does not change this integration.

### Fiat (DOKU Checkout + internal ledger)

Fiat is one namespace: **DOKU Checkout is money-in only** (no Sub-Account); every
balance lives on the internal fiat ledger. See [Fiat & payments](FIAT_PAYMENTS.md).

| Variable | Required | Description |
|---|---|---|
| `DOKU_MODE` | no | `sandbox` (default) or `production` |
| `DOKU_CLIENT_ID` / `DOKU_SECRET_KEY` | yes* | DOKU merchant credentials (Checkout) |
| `DOKU_PRIVATE_KEY` | no | RSA PEM for legacy Sub-Account calls (not needed for Checkout-only) |
| `DOKU_WEBHOOK_URL` | no | Public URL for DOKU payment notifications (`/v1/fiat/webhook`) |
| `DOKU_WEBHOOK_SECRET` | no | Shared secret for DOKU webhook source authentication (generate, set, rotate — see below) |
| `DOKU_CHECKOUT_NOTIFY_URL` | no | Per-payment notify override (defaults to `DOKU_WEBHOOK_URL`) |
| `PID_FIAT_LEDGER_ENABLED` | no | Master switch (default `true`) |
| `PID_FIAT_LEDGER_FROZEN` | no | Freeze new issues/sends (default `false`) |
| `PID_FIAT_LEDGER_TREASURY_PID` | no | Label for the global-fee treasury (env, never hardcoded) |
| `PID_REDEMPTION_ENABLED` | no | Bank withdrawals (default `false`; disabled for now) |

`*` DOKU endpoints fail at call time until these are set. The global fee policy
is versioned in the DB (`fiat_fee_policies`) and can be published by an admin
(`POST /v1/fiat/admin/fee-policy`); per-app fees are configured per app in the
workspace.

> **DOKU webhook source authentication.** Generate a secret
> (`openssl rand -hex 32`), set it as `DOKU_WEBHOOK_SECRET` on the API, and
> configure the tunnel/proxy delivering DOKU notifies to sign every payload
> with `X-Doku-Signature: sha256=<hex HMAC-SHA256(rawBody, secret)>` (bare
> 64-char hex is also accepted). When the secret is set, the inbox verifies
> the signature with a timing-safe compare and rejects unsigned/forged pushes
> with `401` **before any DB write**. Rotate by updating the secret on both
> sides at once. When unset, the inbox is unauthenticated: forged notifies are
> accepted for persistence (up to the 120 req/min route throttle) and the
> persist-then-corroborate model below is the only money safety — never run
> production without the secret.
>
> **Persist-then-corroborate.** The webhook inbox is persist-first: every
> notify is stored (deduped on `X-EXTERNAL-ID`), then corroborated
> server-side against DOKU before any `fiat_issue`. A forged or unknown event
> can never move funds — it stays `received` for admin review.

