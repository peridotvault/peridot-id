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
  topup, withdraw). Minimum top-up **Rp100.000 NET**.
- **Per-app fee** (model A, `PidAppFee`): when a movement is initiated in an
  app's context, that app's fee **stacks** on the global fee and credits the
  app's own account (`ownerPid`). Operations: `topup`, `transaction`, `withdraw`.
- No withdrawal/cash-out (redemption disabled). Any identity can send to any
  identity (escrow is a normal app account; release logic lives in the app).
- Treasury: the global fee credits a synthetic `treasury` owner in replay; the
  PID in `PID_FIAT_LEDGER_TREASURY_PID` is an ops label (env, never hardcoded).

## Journal (`fiat_ledger_entries`)

One logical movement = one `entryGroup`, written atomically:

| Movement | Rows |
|---|---|
| Issue (from `DP-*`) | `fiat_issue` (`in`, NET, to user) + `fiat_fee` (`out` on row, to synthetic treasury) + `fiat_app_fee` (`in`, to app) when app context |
| Send (gross G) | `fiat_transfer_out` (sender, `out`, G) + `fiat_transfer_in` (recipient, `in`, N) + `fiat_fee` (global) + `fiat_app_fee` (to app) when app context |

`fiat_app_fee` credits the app's own `ownerPid` (NOT the synthetic treasury). The
group stays balanced: `G == N + globalFee + appFee`.

- `status`: `created` (intent, not counted) → `posted` (immutable value) |
  `failed` | `cancelled`. Only `posted` counts in replay. Corrections = new rows.
- `idempotencyKey` UNIQUE: `IC-<DP-providerRef>` for issues, transfer entryGroups
  (+`-IN`/`-FEE` legs) for sends. Retries reuse the key.
- `replaySeq` autoincrement: deterministic replay order.
- Replay (`apps/api/src/fiat/fiat-ledger-replay.ts`): `posted` only; group check
  `out == in`; no negative owners; unknown kinds are errors.

## Tamper-evident chain

Every posted row commits to the prior one:
`hash = sha256(canonical(row) ‖ prevHash)`, `hashSeq` = chain position, assigned
inside a global advisory lock. Any edit/delete/reorder/insert of a posted row
breaks verification from that point (`GET /v1/fiat/admin/chain`). This is
tamper-**evident**, not tamper-**proof**: to make it proof, publish the head
hash (`GET /v1/fiat/admin/chain/head`) outside the DB (e.g. on-chain) and
compare later. Backfill pre-existing rows with `POST /v1/fiat/admin/chain/backfill`.
Pure logic + tests: `apps/api/src/fiat/fiat-ledger-hash.ts`.

## Callbacks (escrow apps) — DEFERRED

External callbacks are **not in use yet** (no app UI; nothing enqueues unless a
webhook URL is set). The backend stays dormant for a later re-enable: a party
that owns a `PidApp` with a webhook URL would receive signed callbacks when a
transfer posts, registered via `POST /v1/apps/:id/webhook { url }` (https;
returns the signing secret ONCE). Delivery is an outbox (`fiat_ledger_events`),
async + retried by `POST /v1/fiat/admin/dispatch-events` (cron), HMAC-SHA256 in
`X-Pid-Signature: sha256=<hex>`; event name in `X-Pid-Event`. The ledger remains
the source of truth; apps can also poll `GET /v1/fiat/ledger`.

## Machine auth (app backend)

`POST /v1/auth/token { clientId, clientSecret? }` issues a short-lived bearer
token bound to the app owner's pid, carrying the app's `clientId`. Use
`Authorization: Bearer <token>` — no browser session. It accepts `clientSecret`
when the app has one set (timing-safe). Admin routes reject machine tokens even
for an admin owner. `APP_TOKEN_TTL` (default `1h`).

Typical backend use: read the escrow balance (`GET /v1/fiat/balance`), list the
statement (`GET /v1/fiat/ledger`), initiate escrow releases
(`POST /v1/fiat/transfers/*`), manage fees (`GET/PUT /v1/apps/:id/fees`).

## Per-app fees (API)

`GET /v1/apps/:id/fees` and `PUT /v1/apps/:id/fees/:operation` (owner only).
Operations: `topup`, `transaction`, `withdraw`. Body: `{ percentBps, minIdr,
maxIdr, enabled }` (`minIdr/maxIdr` 0 = unbounded; `minIdr ≤ maxIdr`). The fee
stacks on the global fee and credits the app's account. Apply it by passing
`clientId` on `deposits/checkout` / `transfers/inquiry` (or automatically when
the caller is the app's machine token).

## Atomicity / no double-spend

- Confirm runs in one Prisma `$transaction`: lock sender+recipient `identities`
  rows (`SELECT … FOR UPDATE`, PID-sorted, deadlock-free) → recompute sender
  balance from `posted` rows **inside the txn** → reject if `balance < gross`
  → post all legs (chained) + flip intent to `posted`.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `PID_FIAT_LEDGER_ENABLED` | `true` | master switch for issue + send |
| `PID_FIAT_LEDGER_FROZEN` | `false` | when `true`: new issues/sends rejected, reads stay |
| `PID_FIAT_LEDGER_TREASURY_PID` | `` | treasury label PID (env) |

In-memory freeze override exists for ops (`POST /v1/fiat/admin/freeze`; env is
the default).

## API

`GET /v1/fiat/balance`, `GET /v1/fiat/ledger`, `GET /v1/fiat/fee-policy`,
`POST /v1/fiat/deposits/checkout`, `GET /v1/fiat/deposits`,
`POST /v1/fiat/deposits/:id/sync`, `POST /v1/fiat/transfers/inquiry`,
`POST /v1/fiat/transfers/:id/confirm`, `POST /v1/fiat/transfers/:id/cancel`,
`POST /v1/fiat/webhook`. Admin: `GET /v1/fiat/admin/replay`,
`GET /v1/fiat/admin/journal/:pid`, `POST /v1/fiat/admin/freeze`,
`POST /v1/fiat/admin/backfill`, `GET /v1/fiat/admin/chain`,
`GET /v1/fiat/admin/chain/head`, `POST /v1/fiat/admin/chain/backfill`,
`POST /v1/fiat/admin/dispatch-events`, `GET /v1/fiat/admin/events`.
