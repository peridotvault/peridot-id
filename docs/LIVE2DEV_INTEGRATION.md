# Live2Dev × PeridotID integration

> PeridotID is generic financial infrastructure. It knows `account/identity`,
> `balance/credit`, `send/receive`, and the immutable journal — never `campaign`,
> `developer`, `streamer`, or `deal`. All deal logic lives in Live2Dev.

## Setup

1. Register a third-party app: `POST /v1/apps` → `client_id` (`pidapp_*`),
   `allowedOrigins` = Live2Dev origins. Optional `pidsk_*` secret for
   confidential code exchange.
2. Own a normal PeridotID account, e.g. `live2dev@pid` (1 identity = 1 wallet,
   like any user). It financially behaves as an ordinary participant: it holds
   balance and can send/receive.
3. Ops adds it to the credit allowlist env: `PID_FIAT_LEDGER_APP_ALLOWLIST`
   must include `live2dev@pid`. Treasury label: `PID_FIAT_LEDGER_TREASURY_PID`.
4. Users sign in via SSO (`pid_code` → `POST /v1/auth/exchange`); money ceremonies
   run through the PeridotID popup (`credit-transfer`) with server-quoted
   Approve/Deny — Live2Dev never touches amounts or account numbers.

## Example: 5 streamers × Rp100.000 = Rp500.000

```
developer@pid --send Rp500.000--> live2dev@pid   (user → app: escrow top-up)
live2dev@pid --send Rp100.000--> streamer1@pid   (app → user: payout, ×5 on deal completion)
```

- Any identity can send to any identity; `live2dev@pid` (the escrow account)
  needs no allowlist.
- Live2Dev controls the funds once received and releases per its own business
  logic. (Outbound callbacks are **deferred for now** — poll
  `GET /v1/fiat/ledger` or rely on the machine-token balance below.)
- **Read the escrow balance from your backend** with a machine token:
  `POST /v1/auth/token { clientId, clientSecret }` → then `GET /v1/fiat/balance`
  with `Authorization: Bearer <token>` (the balance of `live2dev@pid`).
- **Charge your own fee** (stacked on the global 0.1%): set it at
  `PUT /v1/apps/:id/fees/{topup|transaction|withdraw}` and pass the app's
  `clientId` when initiating a movement — the fee credits your account.
- Developer tops up via DOKU Checkout first (NET ≥ Rp100.000, fee 5% quoted
  upfront); the credited NET is what they can send.
- Live2Dev tracks which transfer belongs to which deal in its own database
  (PeridotID stores only `remark`/`entryGroup` references).

## Phase-1 limits

- No withdrawal/cash-out (redemption stays disabled).
- No direct user→user sends (policy rejects with 403; full P2P = future flag flip).
- Balances live on the internal fiat ledger (IDR), not yet DOKU POINT — migratable per
  `docs/FUTURE_UNIFIED_LEDGER.md`.
