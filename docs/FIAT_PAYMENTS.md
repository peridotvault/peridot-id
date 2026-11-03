# Direct app payments

`amountIdr` is the amount credited to the beneficiary. Fees are added to the
payer's bill: `grossIdr = netIdr = amountIdr`, `totalIdr = amountIdr + feeIdr`.
The quote uses the existing top-up fee schedule (including app fee, gateway fee,
and taxes). Gateway charges remain provider costs; platform fees and VAT use
the existing treasury/tax ledger buckets. No payer balance is required.

## API

- `POST /v1/fiat/payments/quote`: `{ amountIdr, clientId?, paymentMethod? }`.
- `POST /v1/fiat/payments`: same fields plus `externalId`, optional
  `beneficiaryPid`, `payerPid` (machine callers only), `description`, `metadata`.
- `GET /v1/fiat/payments/:id`: intent, metadata, timestamps and refunded amount.
- `GET /v1/fiat/payments`: latest 100, optional `externalId`, `status`,
  `createdAfter` (ISO date), `clientId` (session callers).
- `POST /v1/fiat/payments/:id/cancel`: created/pending only.
- `POST /v1/fiat/payments/:id/refund`: `{ requestId, amountIdr? }`; omit amount
  to refund the remaining principal. Fees are not refunded. Refunds are ledger
  credits to the original payer, not bank/card reversals. The beneficiary must
  authorize the refund and have sufficient available balance.

Machine tokens must request `scope: "fiat:payment"` from `/v1/auth/token`.
The token fixes app context. Session callers provide `clientId`; the session
fixes payer identity. Machine callers can supply a payer PID for attribution
(the app asserts this identity); omitted payer stays null and cannot receive a
PID refund. A machine token is never treated as a human payer. Any registered
PID can be a beneficiary (default: the app owner) — no operator registration or
allowlist is involved; the app record the developer created in the dashboard is
the onboarding.

`paymentMethod` is required: it determines the DOKU gateway fee included in
`totalIdr`. Without it the platform would absorb the provider fee on every
payment.

`externalId` is unique per app. Only the request that inserts the intent calls
DOKU. Retries return the same intent; conflicting payer/amount/beneficiary
returns 409. If DOKU creation times out, the intent stays created for
reconciliation; retries never create another invoice. A created intent without
a URL needs operational investigation if DOKU never returns its URL.

The default expiry is 30 minutes, sent to DOKU. The provider's returned expiry
is interpreted in WIB. Recovery of abandoned orders is explicitly disabled.
The API suppresses URLs after expiry/cancellation. Cancellation is local: the
Checkout API client has no provider cancellation operation. A previously copied
DOKU link can still be paid until provider expiry; confirmed late payments are
accounted for and can be refunded. Do not interpret local cancellation as a
bank reversal or a guarantee that DOKU revoked the URL.

## Limits

The floor is a code constant (`apps/api/src/fiat/fiat-limits.ts`), identical for
every app in production and sandbox: **Rp10.000 NET minimum**. There is no env
var and no per-app override. Quotes expose `minimumIdr`. Rejections use HTTP 400:

```json
{"code":"MIN_AMOUNT_BELOW_FLOOR","minimumIdr":"10000","message":"Amount below minimum"}
```

A single direct payment is capped at **Rp10.000.000** (`MAX_PAYMENT_IDR`, same
file): `{"code":"PAYMENT_ABOVE_CEILING","maximumIdr":"10000000"}`. The cap is the
abuse guard that replaced the old operator allowlist.

Deposit intents snapshot their minimum so later policy changes do not prevent
crediting an already accepted deposit. The SDK retains structured error fields.

## Webhooks

Configure with `POST /v1/apps/:id/webhook`. Destinations must be public HTTPS
endpoints; localhost/private addresses and redirects are rejected during delivery.
For local development use a public HTTPS tunnel.

Events: `fiat.payment.paid`, `fiat.payment.expired`, `fiat.payment.failed`,
`fiat.deposit.paid`, `fiat.transfer.posted`. Payloads include stable `eventId`,
`type`, `occurredAt`, `appClientId`, `externalId` (null for unassociated deposits
and transfers), payment/deposit/transfer ID, `amountIdr`, `feeIdr`, `payerPid`.

Verify `X-Pid-Signature: sha256=<hex>` using HMAC-SHA256 over the exact raw body
and the app webhook secret. Delivery is at least once; deduplicate by eventId.
Ledger posting and outbox insertion are atomic. The API worker checks every two
seconds, with per-event leases across replicas, five-second request timeouts,
and exponential retry capped at one hour. Forty attempts provide a retry
window longer than 24 hours. The worker cadence is not an end-to-end latency SLA;
DOKU notification timing, provider availability and queue size still matter.

Owners can inspect the latest 100 deliveries using
`GET /v1/apps/:id/webhook/deliveries` and replay using
`POST /v1/apps/:id/webhook/deliveries/:eventId/replay`. Replay retains eventId and
payload. The app detail dashboard exposes these operations. The delivery row
records latest status/error and attempt count, not a separate history per attempt.

## Rollout and verification

Apply the Prisma migration before starting the API. Use the existing sandbox
DOKU credentials (`DOKU_MODE=sandbox`) and a public notification URL. No mock
PAID endpoint is exposed. DOKU sandbox payments must be simulated through the
provider's supported sandbox flow; the API corroborates order status and exact
total before posting.

Local automated tests cover no-balance creation, replay, duplicate settlement,
amount mismatch, expiry, refund limits, authorization, metadata byte limits,
minimums and webhook signatures/retries. Before deployment acceptance, run the
actual DOKU sandbox loop including simultaneous duplicate requests, expiry of
a copied payment URL, HTTP 500 retries, dashboard replay and delivery latency.
Bank withdrawal remains disabled; this change does not provide cash-out.
