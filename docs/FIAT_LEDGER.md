# Fiat ledger

> Status: **ACTIVE** — the one balance rail. Postgres is the temporary truth.
> DOKU Checkout is **money-in only** (no Sub-Account). `PID_FIAT_LEDGER_ENABLED`
> defaults to `true`. Migrates back to the DOKU Unified Ledger per
> `docs/FUTURE_UNIFIED_LEDGER.md`; journal rows are never deleted.

## Model

- One namespace: **fiat**. `account/identity`, `balance/credit`, `send/receive`,
  immutable journal. No `campaign/developer/streamer/deal` concepts here.
- Money-in: DOKU Checkout SUCCESS (corroborated + exact amount-match) → **NET**
  becomes the user's balance (`fiat_issue` + `fiat_fee`). Only Checkout deposits
  issue; VA/inbound-unknown rows never do.
- Economics (locked): global PeridotID fee = **0.1% (10 bps), min Rp100, no cap**
  (`calcServiceFee`, active `FiatFeePolicy`), snapshotted per movement
  (`feePolicyVersion`). Applies to every fiat movement (user↔user, escrow,
  topup) **except withdrawals**, which use their own dedicated policy — see
  **Withdrawals (flagged off)** below. Minimum top-up **Rp10.000 NET**.
- **PPN (VAT), configurable, never hardcoded**: `FiatFeePolicy.taxBps` (PeridotID
  PPN on its fee, default 1100 = 11%) and the singleton `FiatTaxSetting.dokuTaxBps`
  (DOKU PPN on the gateway fee, default 1100). Tax is computed on the **fee**, not
  on the credited Amount, and never on the app fee. Collected PeridotID PPN posts
  as **`fiat_tax`** to a synthetic `tax` bucket (a liability, not revenue).
- **App categories** (fee policy): **Verified App** (`PidApp.isVerified`, admin-only)
  pays **0% PeridotID fee** — its own stacked fee still applies — and **Public App**
  pays the global 0.1% (min Rp100, no cap). Both must use the PeridotID DOKU gateway.
- **Per-app fee** (model A, `PidAppFee`): when a movement is initiated in an
  app's context, that app's fee **stacks** on the global fee and credits the
  app's own account (`ownerPid`). Operations: `topup`, `transaction`, `withdraw`.
- **Payment gateway (DOKU) fee** on top-ups: one **checkbox per payment method**
  (Virtual Account / e-Wallet / Card / QRIS), resolved by `PaymentFeeService`
  (`payment_gateway_fee_rates`, admin-edited) with a DOKU API hook
  (`DokuCheckoutClient.transactionFee`) that returns null today — DOKU Checkout
  has no fee-inquiry API. **Checked = offered in the wallet and fee charged;
  unchecked (or no row) = hidden from the wallet picker and not charged** (a
  disabled row shadows the `"*"` fallback). Default is off, so the wallet blocks
  top-ups until at least one method is enabled. See below.
- No withdrawal/cash-out in production today: redemption is disabled and the
  withdrawal surface is **flagged off** (see **Withdrawals (flagged off)** below).
  Any identity can send to any identity (escrow is a normal app account; release
  logic lives in the app).
- Treasury: the global fee credits a synthetic `treasury` owner in replay; PPN
  credits a synthetic `tax` owner. The PID in `PID_FIAT_LEDGER_TREASURY_PID` is an
  ops label (env, never hardcoded).

## Withdrawals (flagged off)

The withdrawal surface is **not enabled** and must not be enabled in any real
environment until the ANT-990 launch gates close: env `PID_WITHDRAWALS_ENABLED=true`
**and** settings `featureEnabled=true`, plus G1–G10 and an explicit board go/no-go.
Both flags stay `false` in real environments; synthetic/staging may run seeded users
and a fake provider only. Design and contract live in the
[ANT-990 PRD](/ANT/issues/ANT-990) (decisions D1–D10, §4.4–§4.5, §7.1).

**Reservation and available balance.** Creating a withdrawal writes an **active
reservation** for the **gross** amount (`grossAmountIdr`), atomically with the
request under the identity lock. The reservation is an **encumbrance only**: it
writes **no** journal entry and no ledger statement line before verified
settlement. It is released on user cancel before export and on expiry, and it is
held while the request is in `RECONCILIATION`.

```
reservedIdr  = SUM(amount_idr) over the user's active reservations
availableIdr = balanceIdr - reservedIdr      (never negative)
```

`balanceIdr` remains the replayed posted balance; every spending path must check
`availableIdr`. The journal is posted only at **verified settlement**
(provider/bank result), and its group must satisfy
`gross == net + fee + tax + appFee` exactly.

**Fee policy — the generic 0.1% does not apply.** The locked global policy above
(**0.1%, min Rp100, no cap** — `DEFAULT_FEE_POLICY` / active `FiatFeePolicy`) does
**not** apply to withdrawals, and neither do the `FiatFeePolicy` row defaults
(500 bps, cap Rp25.000). Withdrawals resolve **only** the dedicated, versioned
withdrawal fee policy (`withdrawalFeePolicyVersion`, ANT-990 §5.12/§7.1.1):

- `feeEnabled=false` (the default) ⇒ `feeIdr=0`, `taxIdr=0`, and no "free"/"gratis" claim.
- `feeEnabled=true` and the dedicated policy missing/unreadable ⇒
  `503 FEE_POLICY_UNSET`; no quote is issued and there is **no fallback** to either
  default (ANT-990 AC-31). Quote and receipt return the resolved
  `withdrawalFeePolicyVersion` so QA can prove which numbers were used.
- `netIdr = grossIdr - feeIdr - taxIdr - appFeeIdr` must be `> 0`; otherwise reject
  `NET_NOT_POSITIVE`.
- No fee percentage is set here. Enabling a fee requires counsel confirmation that
  it is not a prohibited redemption fee, then a settings change with
  `counselReference`.

No public/user-visible withdrawal copy exists before the launch gates; it is
counsel-gated (ANT-990 G6, `[OPEN-COUNSEL]`).

## Journal (`fiat_ledger_entries`)

One logical movement = one `entryGroup`, written atomically:

| Movement | Rows |
|---|---|
| Issue (from `DP-*`) | `fiat_issue` (`in`, NET, to user) + `fiat_fee` (`out` on row, to synthetic treasury) + `fiat_tax` (PeridotID PPN → tax bucket) + `fiat_app_fee` (`in`, to app) when app context |
| Send (gross G) | `fiat_transfer_out` (sender, `out`, G) + `fiat_transfer_in` (recipient, `in`, N) + `fiat_fee` (global) + `fiat_tax` (PPN) + `fiat_app_fee` (to app) when app context |

`fiat_app_fee` credits the app's own `ownerPid` (NOT the synthetic treasury). The
group stays balanced: `G == N + globalFee + tax + appFee`.

- `status`: `created` (intent, not counted) → `posted` (immutable value) |
  `failed` | `cancelled`. Only `posted` counts in replay. Corrections = new rows.
- `idempotencyKey` UNIQUE: `IC-<DP-providerRef>` for issues, transfer entryGroups
  (+`-IN`/`-FEE`/`-TAX` legs) for sends. Retries reuse the key.
- `replaySeq` autoincrement: deterministic replay order.
- Replay (`apps/api/src/fiat/fiat-ledger-replay.ts`): `posted` only; group check
  `out == in`; no negative owners (incl. `tax`); unknown kinds are errors.

## Tamper-evident chain

Every posted row commits to the prior one:
`hash = sha256(canonical(row) ‖ prevHash)`, `hashSeq` = chain position, assigned
inside a global advisory lock. Any edit/delete/reorder/insert of a posted row
breaks verification from that point (`GET /v1/fiat/admin/chain`). This is
tamper-**evident**, not tamper-**proof**: to make it proof, publish the head
hash (`GET /v1/fiat/admin/chain/head`) outside the DB (e.g. on-chain) and
compare later. Backfill pre-existing rows with `POST /v1/fiat/admin/chain/backfill`.
Pure logic + tests: `apps/api/src/fiat/fiat-ledger-hash.ts`.

## Callbacks (app webhooks) — ACTIVE

A party that owns a `PidApp` with a webhook URL receives signed callbacks:
`fiat.payment.paid|expired|failed`, `fiat.deposit.paid`, `fiat.transfer.posted`.
Registered via `POST /v1/apps/:id/webhook { url }` (https; returns the signing
secret ONCE). Delivery is a transactional outbox (`fiat_ledger_events`) drained
by an in-process worker every 2 seconds with per-event leases, HMAC-SHA256 in
`X-Pid-Signature: sha256=<hex>`; event name in `X-Pid-Event`. Retries use
exponential backoff for >24h (40 attempts). Owners can inspect and replay
deliveries from the dashboard or `GET /v1/apps/:id/webhook/deliveries`. The
ledger remains the source of truth; apps can also poll `GET /v1/fiat/ledger`.

## Machine auth (app backend)

`POST /v1/auth/token { clientId, clientSecret?, scope? }` issues a short-lived
bearer token bound to the app owner's pid, carrying the app's `clientId`. Use
`Authorization: Bearer <token>` — no browser session. It accepts `clientSecret`
when the app has one set (timing-safe). Admin routes reject machine tokens even
for an admin owner. `APP_TOKEN_TTL` (default `1h`).

Pass `scope: "fiat:transfer"` for the least-privilege escrow-release form
(ANT-286b, enforced by ANT-344 H3): scoped tokens are the ONLY machine tokens
that may initiate `POST /v1/fiat/transfers/*` — JwtAuthGuard and the ledger
service both reject unscoped or mis-scoped machine tokens 403 (fail closed).
Every app-token use on inquiry AND confirm emits
`fiat.transfer.app_token` with `{ app, scope }` — the SOC anomaly signal for a
leaked app secret (an app token appearing from an unexpected network/pattern).

Typical backend use: read the escrow balance (`GET /v1/fiat/balance`), list the
statement (`GET /v1/fiat/ledger`), initiate escrow releases
(`POST /v1/fiat/transfers/*`), manage fees (`GET/PUT /v1/apps/:id/fees`).

### `pidsk_` rotation guidance

The backend secret (`pidsk_…`, set via `POST /v1/apps/:id/secret`) expires
after 365 days (`clientSecretExpiresAt`); past expiry every exchange/token call
with the old secret fails closed until the owner rotates. Rotate proactively:

- **Schedule:** rotate at least every 365 days (before expiry) and on every
  staff exit with backend-secret access.
- **Suspected leak:** rotate immediately, then review `fiat.transfer.app_token`
  SOC events (and 403 spikes on `POST /v1/fiat/transfers/*`, which now reject
  unscoped tokens) for unexpected app-token use
  (unknown source, odd hours, unfamiliar amounts).
- **Grace procedure:** mint the new secret (`POST /v1/apps/:id/secret` returns
  it ONCE — store it in the backend vault, never in code), deploy the backend
  to the new value, verify `POST /v1/auth/token` + one read (`GET
  /v1/fiat/balance`) with the new secret, then retire the old value. There is
  no overlap window server-side — the single stored hash flips on rotation —
  so keep the cutover tight and confirm the first scoped
  (`scope: "fiat:transfer"`) transfer inquiry succeeds before closing.

## Per-app fees (API)

`GET /v1/apps/:id/fees` and `PUT /v1/apps/:id/fees/:operation` (owner only).
Operations: `topup`, `transaction`, `withdraw`. Body: `{ percentBps, minIdr,
maxIdr, enabled }` (`minIdr/maxIdr` 0 = unbounded; `minIdr ≤ maxIdr`). The fee
stacks on the global fee and credits the app's account. Apply it by passing
`clientId` on `deposits/checkout` / `transfers/inquiry` (or automatically when
the caller is the app's machine token). For **withdrawals** (flagged off) the
app fee is part of the withdrawal fee model and is disabled together with
`feeEnabled`; it never stacks on the global 0.1% fee — see
**Withdrawals (flagged off)** above.

## Top-up fees & checkout summary

The PeridotID checkout summary — wallet `TopupScreen` and the `fiat-checkout`
popup (`ApproveScreen`) — is shown **before** redirecting to DOKU, as a single
combined fee line plus the app's own fee:

```
Amount             (net credited)
Transfer Fee       = PeridotID fee + PeridotID PPN + DOKU gateway fee + DOKU PPN
App Fee            (only when the app stacks one — never PPN'd by PeridotID)
Total Payment
```

PPN is folded into `Transfer Fee`; the API still returns the parts separately.

- `POST /v1/fiat/deposits/quote` (auth) quotes this without moving money:
  `{ netAmountIdr, clientId?, paymentMethod? }` → `peridotFeeIdr` + `peridotTaxIdr`,
  `gatewayFeeIdr` + `gatewayTaxIdr`, `appFeeIdr`, `appCategory` (`verified` |
  `public`), total, and `paymentMethods[]` (**enabled methods only** — empty ⇒ the
  wallet shows "no payment methods" and blocks Pay). Verified apps have
  `peridotFeeIdr = 0` ⇒ PPN 0; a requested disabled method is rejected.
- `POST /v1/fiat/deposits/checkout` accepts `paymentMethod` (a category key like
  `VIRTUAL_ACCOUNT`/`EWALLET`/`CARD`/`QRIS`, or a specific DOKU code). The fee is
  recomputed server-side and the DOKU `payment_method_types` are locked to the
  pick; a disabled method is rejected. `grossIdr`/`totalIdr` = the total payable.
- Gateway fees are internal config, not hardcoded: `PaymentFeeService` resolves
  exact method code → category → `"*"` against `payment_gateway_fee_rates`
  (`GET /v1/fiat/admin/payment-fee-rates` returns the category catalog + stored
  extras; `PUT /v1/fiat/admin/payment-fee-rates/:methodKey`;
  body `{ percentBps, flatIdr, minIdr, maxIdr, enabled }`). The DOKU-wide PPN is
  `GET/PUT /v1/fiat/admin/doku-tax` `{ taxBps }`. Set
  `PID_DOKU_FEE_API_ENABLED=true` to try the DOKU fee hook first (currently null).

## Atomicity / no double-spend

- Confirm runs in one Prisma `$transaction`: lock sender+recipient `identities`
  rows (`SELECT … FOR UPDATE`, PID-sorted, deadlock-free) → re-read intent
  status **inside the txn** (a `cancel` racing `confirm` loses: cancel takes
  the same lock, so whoever holds it first wins) → recompute sender
  balance from `posted` rows **inside the txn** → reject if `balance < gross`
  → post all legs (chained) + flip intent to `posted`.
- Balance reads are bounded (`take: 5000/10000`) and return `truncated: true`
  when the cap is hit — a truncated verdict is partial, never silently exact.
- Scope: these guarantees cover the **fiat internal-credit rail only**.
  Wallet SOL/SPL flows (`withdraw`/`execute`) are lock-free check-then-broadcast
  against live RPC balances with on-chain nonce replay protection — they do not
  inherit this section's transactional guarantees.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `PID_FIAT_LEDGER_ENABLED` | `true` | master switch for issue + send |
| `PID_FIAT_LEDGER_FROZEN` | `false` | when `true`: new issues/sends rejected, reads stay |
| `PID_FIAT_LEDGER_TREASURY_PID` | `` | treasury label PID (env) |
| `PID_FIAT_LEDGER_APP_ALLOWLIST` | `` | Optional transfer allowlist: comma-separated PIDs allowed on one side of a transfer. Recipients that own an active `PidApp` (created in the dashboard) are eligible without it; app owners need nothing from ops. |
| `DOKU_WEBHOOK_SECRET` | `` | Source auth for `POST /v1/fiat/webhook` (M11): when set, pushes must carry `X-Doku-Signature: sha256=<hex HMAC-SHA256(rawBody)>` (else 401 before any DB write). Provision in deployed envs. |

In-memory freeze override exists for ops (`POST /v1/fiat/admin/freeze`; env is
the default).

## API

`GET /v1/fiat/balance`, `GET /v1/fiat/ledger`, `GET /v1/fiat/fee-policy`,
`POST /v1/fiat/deposits/quote`, `POST /v1/fiat/deposits/checkout`,
`GET /v1/fiat/deposits`,
`POST /v1/fiat/deposits/:id/sync`, `POST /v1/fiat/transfers/inquiry`,
`POST /v1/fiat/transfers/:id/confirm`, `POST /v1/fiat/transfers/:id/cancel`,
`POST /v1/fiat/webhook`. Admin: `GET /v1/fiat/admin/replay`,
`GET /v1/fiat/admin/journal/:pid`, `POST /v1/fiat/admin/freeze`,
`POST /v1/fiat/admin/backfill`, `GET /v1/fiat/admin/chain`,
`GET /v1/fiat/admin/chain/head`, `POST /v1/fiat/admin/chain/backfill`,
`POST /v1/fiat/admin/dispatch-events`, `GET /v1/fiat/admin/events`,
`GET/PUT /v1/fiat/admin/payment-fee-rates[/:methodKey]`,
`GET/PUT /v1/fiat/admin/doku-tax`.
