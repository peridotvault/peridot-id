# Fiat Sub-Account V2 — Peridot identity, DOKU ledger

Peridot ID is the **identity/orchestration layer**; **DOKU is the
authoritative financial ledger** — both for fiat (IDR/Pending accounts) and
for the spendable balance (Unified Ledger POINT accounts, 1:1 IDR peg).
Local Postgres rows are an **immutable transaction journal**: references,
statuses, idempotency keys, snapshots, and read-optimized projections only.
The app **never calculates or mutates an authoritative balance** — every
displayed number comes from a live DOKU response; every movement is a DOKU
call keyed by a unique reference.

Official contracts only: `developers.doku.com/wallet-as-a-service/sub-account/sub-account-v2`
(register, balance-inquiries, transaction-history-list, transactions-status,
transfer-inquiry/payment, debit/cancel, split-rules), the account-management
and collect-and-route guides, and `developers.doku.com/accept-payments/doku-checkout`
(backend-integration: `POST /checkout/v1/payment`, non-SNAP signing).
Nothing below is assumed from unofficial sources.

## Hierarchy (no product parents)

```
Peridot ID (Main Merchant, root)
├── Users (parent Sub-Account for EVERY PID financial account)
│   ├── <pid-A> Sub-Account   (1 PID = 1 User Sub-Account)
│   ├── <pid-B> Sub-Account
│   └── …
└── Treasury (system Sub-Account for fee settlement — NOT under Users)
```

- `Users` and `Treasury` are provisioned **once, manually, via the DOKU
  dashboard**. Their IDs go in env: `DOKU_USERS_PARENT_PROFILE_ID`,
  `DOKU_TREASURY_PROFILE_ID` / `DOKU_TREASURY_ACCOUNT_NO`.
- `registerAccount` creates each PID account as a child of `Users`
  (`parentProfileId = DOKU_USERS_PARENT_PROFILE_ID`, legacy
  `DOKU_SAC_PARENT_PROFILE_ID` fallback). Exactly `1 PID = 1 User
  Sub-Account`.
- Never create hierarchy by product (no Live2Dev / Peridot parents):
  every product uses the same per-PID balance.
- Env: `DOKU_MODE/CLIENT_ID/SECRET_KEY/PRIVATE_KEY` (+ `DOKU_SAC_TYPE`,
  `DOKU_USERS_PARENT_PROFILE_ID`, `DOKU_TREASURY_PROFILE_ID`,
  `DOKU_TREASURY_ACCOUNT_NO`, `DOKU_TREASURY_POINT_ACCOUNT_NO`,
  `DOKU_SYSTEM_POINT_ACCOUNT_NO`, `DOKU_SPLIT_RULE_ID`, `DOKU_WEBHOOK_URL`,
  `DOKU_CHECKOUT_NOTIFY_URL`).

## End-to-end flow (ledger-first)

```
login (Google/passkey, existing) → POST /v1/fiat/sub-accounts/accounts {name,email}
→ active (child of Users: profileId + IDR + POINT accounts + static BRI VA, server-side — no OTP)
→ one-time ops: activate Unified Ledger, verify DOKU_SYSTEM_POINT,
  (optional) create fiat split rule → DOKU_SPLIT_RULE_ID
→ deposit: POST .../deposits/checkout {netAmountIdr ≥ 100000} → DOKU-hosted
  page (customer charged gross = net + flat-5% fee)
→ paid webhook → persist → txStatus corroborate → amount-match vs invoice
→ issue NET points (user) + FEE points (Treasury) via DOKU_NON_FIAT top-ups
→ Saldo (= live POINT balance) usable in seconds — no settlement wait
→ later: fiat settles 100% to user IDR = backing event only (backend)
→ user→user: POST .../transfers/inquiry {beneficiaryPid} → /confirm:
  NET points P2P + FEE points P2P to Treasury
→ webhook persist-first → corroborate → reconcile/sweep (complete legs,
  backing report, drift alerts)
(Bank payouts deferred — no fiat-out rail in this build.)
```

## Money model (DOKU-ledger-first)

- **Spendable Saldo = DOKU `DOKU_MERCHANT_POINT` available, 1:1 IDR peg.**
  The UI shows one Saldo number and Processing/Completed/Failed states —
  never PTS, pending, settlement, or Sub-Account terminology.
- Checkout deposits are **NET-in** (min Rp100.000 NET, API-enforced):
  `fee = flat 5% of net` (half-up, no cap), `gross = net + fee`.
- **Issuance (backend-only):** on corroborated payment the backend issues
  two `DOKU_NON_FIAT` top-ups from `DOKU_SYSTEM_POINT`: `{ref}-PTS` (NET →
  user POINT) and `{ref}-PTS-FEE` (FEE → Treasury POINT, redeemable —
  Treasury pays out from it later). Refs are unique → no double issue;
  409 → corroborate-and-adopt. No route/SDK/screen can issue (CI-guarded).
- **Amount-match gate:** the corroborated paid amount must equal the
  server-created invoice gross, else issuance is BLOCKED (`ledgerStatus:
  blocked`) for ops review. User input creates invoices; only verified
  DOKU money creates points.
- **Fiat settlement = backing, never a credit.** Checkout fiat settles 100%
  to the user IDR account (no fiat split — fee already moved as points).
  Statuses are separate columns: `providerStatus` (payment),
  `ledgerStatus` (pending/issued/partial/failed/blocked/clawed_back),
  `settlementStatus` (pending/settled).
- **Backing invariant:** redeemable outstanding points (user + Treasury) vs
  fiat (IDR + pending). The gap ≈ cumulative DOKU PG channel fees (taken
  pre-settlement); recon reports `gap`, `pgObserved`, and alerts on drift
  beyond tolerance. Treasury points are first-class redeemable balances.
- **Transfers are POINT P2P**, addressed by recipient PID (resolved
  server-side). GROSS-in points; NET to recipient, FEE to Treasury
  (`{ref}-PTFEE`, sweep-retryable).
- **Clawbacks** (failed/charged-back after issue): POINT debit (partial,
  retry-safe, `{parent}-CLAWBACK-{n}`), admin-triggered. Void-topup only
  for full-exact reversals (non-idempotent by DOKU design).
- VA deposits (no entered amount): same issuance path after corroboration;
  below-minimum-net still flagged, funds preserved.
- Every movement carries explicit source, destination, amount, currency,
  DOKU ref, status, timestamp, and idempotency key in the journal.

## State machines

- Account: `creating → active | failed` (suspended set from DOKU signals).
  A failed call marks the row `failed` (never stuck `creating`), so retry
  works immediately; true concurrency is guarded in-memory (409). A dead
  `creating`/`failed` row without `profileId` re-registers with a warn log
  (possible DOKU-side orphan).
- **Orphan recovery** (call landed at DOKU, response lost): DOKU answers
  `Email Already Exists` on retry — surfaced as 409, never auto-retried.
  Recover via dashboard (find the profileId by email) then:
  `UPDATE fiat_provider_accounts SET profileId='<id>',
  accountStatus='active' WHERE pid='…'`; `balance()` fills the accounts cache.
- **Identity naming + email scope (verified against sandbox, Sep 2026):**
  the DOKU-side account `name` is always the pid (e.g. `ifal@pid`), never
  the display name. DOKU rejects a register email that is already used —
  **including the merchant profile's own email** — so each PID needs a login
  email distinct from the merchant account email (the merchant cannot
  self-onboard with the merchant email; use a separate login).
- Money tx: `created → processing → settled | failed | refunded | cancelled`; `cancel` from `created` only.
  Three independent statuses per movement: `providerStatus` (payment),
  `ledgerStatus` (`pending → issued | partial | failed | blocked | clawed_back`),
  `settlementStatus` (`pending → settled`). Settlement is a backing event,
  never a second user credit.
- Point legs: `{parent}-PTS` (user NET), `{parent}-PTS-FEE` (Treasury FEE),
  `{parent}-PTFEE` (transfer fee), `{parent}-CLAWBACK-{n}` — all unique refs,
  all corroborated via `transactions-status`.
- Webhook: `received → applied | rejected`; duplicate `X-EXTERNAL-ID` = no-op

## Safety rules

- Every DOKU-initiated movement creates the `FiatProviderTransaction` row
  (unique `providerRef` = `partnerReferenceNo`) **before** calling DOKU;
  retries reuse the same ref. Inquiry and payment share one `partnerReferenceNo`
  (DOKU requirement). Register inserts the `creating` row before the call
  (no blind retry — a post-success network error must not fork a second account).
- Provider calls retry transient faults only (network/5xx/429, backoff+jitter);
  definitive 4xx answers are never retried. 429 → 503, 409 → sync-don't-resend.
- All provider money parses strictly to integer IDR at the boundary
  (`parseIdrStrict`); unparseable rows are flagged, never zeroed.
- Webhook signing has **no published V2 contract**, so pushes are hints:
  persist on `X-EXTERNAL-ID`, corroborate via `transactions-status`, apply
  only on corroboration. Unmatched/unparseable events stay `received`.
- The B2B token lives in **backend memory only** (never DB, never frontend).
  Checkout uses non-SNAP HMAC-SHA256 per call (no bearer token involved).
  No secrets/private keys are stored in any table.
- No local ledger at all: spendable and fiat balances come from
  `balance-inquiries`; history math must exclude `VOID` rows
  (`balance = Σ(status ≠ VOID)`). The DB is a journal + timestamped read
  cache (`lastBalance`, `lastPointBalance`).
- **Issuance security: points are NEVER issued from user input.** User
  requests create invoices; points are created only inside
  `issuePointsForDeposit` after server-side `transactions-status`
  corroboration + invoice amount-match. No route, SDK method, or wallet
  screen may issue points (CI-guarded). Webhook pushes are untrusted hints
  until corroborated.
- Reconciliation completes outstanding issuance, backfills missed inbound
  deposits, marks fiat settlement (backing only), flags `belowMinimumNet`
  VA-scale credits, and reports `pendingIssuance`, backing gap, PG-observed
  totals, and drift. Double issuance is impossible by construction — one
  deterministic ref per leg, unique constraint, 409-corroborate. Split and
  point legs sharing the parent reference are never backfilled as separate
  deposits.
- Scale posture: per-PID idempotent reconcile + bounded admin sweep
  (`POST admin/sweep`, cursor-paginated) instead of background daemons;
  history pages capped (truncation flagged).
  100K–1M PID capacity is **not** confirmed by DOKU (see blockers).

## Double-entry PTS journal & reconciliation invariants

Every PTS movement is a balanced set of journal legs sharing an
`entryGroup`, folded in `replaySeq` order by the pure `replayJournal`
(`apps/api/src/fiat/ledger-replay.ts` — the same function recon and tests
use):

- Deposit issuance: `points_issue` (in, user) + `points_fee` (treasury).
  The deposit parent row is fiat intent — never PTS value.
- P2P transfer (gross G, fee F, net N): parent `transfer_internal` (out, G)
  + `points_credit` mirror (in, N, keyed by DOKU's `referenceNo`) +
  `points_fee` (treasury, in, F). G == N + F per group, enforced by replay.
- Clawback: `points_clawback` (out). Redemption burn: `points_redeem`
  (out, `extinguished=true` — burned units can never be re-credited).
- Legacy IDR-era rows and fiat-intent kinds are skipped by replay (counted,
  never valued). Only `settled` rows count; the rest is reported in-flight.
- Claim ownership vs fiat location are fully separated: after
  Alice→Bob→Charlie→David, fiat may sit in Alice's sub-account while David
  owns the claim — replay answers ownership from the journal alone.

Two invariants, checked separately:
1. **Ledger integrity (EXACT):** `replay(journal) == live DOKU POINT
   balances`, per PID and platform-wide. Any mismatch is a P0 alert.
2. **Aggregate backing (tolerance-banded):** total outstanding redeemable
   PTS vs total fiat (`available + pending`, all user + Treasury accounts)
   plus explicit adjustments (observed SETTLEMENT_FEE PG rows, reserves).
   Tolerance = 1% of outstanding (min Rp10.000): bounds leg-settlement /
   history-visibility skew, calibrated from sandbox PG observations.
   Per-PID fiat gaps are info-only — P2P makes per-user PTS↔fiat equality
   invalid by construction.
- Settlement (`pending → available`) flips `settlementStatus` only. Tests
  assert it creates zero legs and reassigns nothing.
- Same-PID movements serialize via in-process pid locks (sender+recipient
  sorted for P2P); DOKU remains the final arbiter; every retry reuses refs.

## Redemption design (resolved — implementation behind verification flag)

Resolutions to the Phase-3 design questions:
1. **Phases 1–3 (journal/replay/locking/recon) land now; redemption stays
   behind a feature flag** until DOKU `BANK_ACCOUNT` payout + liquidity
   consolidation are sandbox-verified. No payout code ships before that.
2. **No claimant-local fiat, ever.** Payout source is a Treasury/operating
   liquidity pool (to be verified) or DOKU-supported just-in-time
   consolidation transfers (each journaled/reconciled as real DOKU
   movements). Bob redeems from pool liquidity because the replay says he
   owns the claim — never because fiat sits in Bob's sub-account.
3. **Tolerance is scaled, adjustments explicit** (see above) — no arbitrary
   fixed number; every adjustment row is reported, never netted silently.
4. **Historical mirrors: authoritative-first.** `POST admin/backfill-mirrors`
   reconstructs from `transactions-status` (settled ⇒ mirror, flagged
   `source: mirror-backfill`); anything else joins the auditable
   `manualReview` queue — never invented.

DOKU capability finding (docs, not yet sandbox-proven): an IDR debit
credits the Level-1 merchant profile's `DOKU_MERCHANT_IDR`, which suggests
a merchant-level operating balance exists — but **no documented endpoint
sweeps user-sub-account IDR into it**, so a dedicated Treasury/operating
pool or consolidation flow is UNCONFIRMED and stays a sandbox blocker.
Target redemption saga (to build after verification):
`deposit → PTS liability → arbitrary P2P → claimant from replay →
PTS reserved/extinguished (POINT debit) → DOKU payout from pool liquidity
→ redemption completed`, with crash-between-burn-and-payout auto-flagged
critical by the sweep. UI stays simple throughout: Saldo, transfer and
withdrawal statuses only.

## Exact blockers (stopped here, not guessed)

0. **Unified Ledger activation + POINT sandbox verification.** The ledger
    model needs the Unified Ledger service activated on the merchant account
    and a `DOKU_SYSTEM_POINT` account (verify via merchant-profile
    `balance-inquiries` before first issuance). Still to verify in sandbox:
    (a) `DOKU_NON_FIAT` top-up `amount: {value, POINT}` acceptance +
    `fromAccount` override behavior;
    (b) `DOKU_SUB_ACCOUNT` + `POINT` P2P (incl. `beneficiaryBankCode`
    omission) and POINT `PURCHASE` debit/retire;
    (c) TOPUP/transfer/debit notification payload shapes for webhook
    branching;
    (d) the per-channel PG-fee schedule (explains the backing gap);
    (e) `additional_info` casing for Checkout (camelCase in SAC guide vs
    snake_case in Checkout schema — a test payment decides).
    Until verified: sweep `pendingIssuance` is the safety net.
1. **Fiat split rule retired** — fees move as Treasury POINTS at issuance,
    so `DOKU_SPLIT_RULE_ID` is NOT passed on payments (it would double
    charge). The `admin/split-rules` passthrough remains for future
    fiat-side use; rule list/get/update/delete are undocumented.
2. **Checkout `additional_info.account` casing** — the SAC guide shows
   camelCase `additionalInfo`; Checkout's schema is snake_case
   (`additional_info`) and does not list `account`. Snake_case is
   implemented (isolated constant `CHECKOUT_SAC_ACCOUNT_KEY`) and must be
   sandbox-verified; invalid ids fail silently (manual ops resolution).
3. **Checkout notify payload shape** — mitigated: every notify is
   corroborated via SAC `transactions-status`/history on the invoice number
   before any state change.
4. **Per-channel Direct API schemas** — create-VA bodies sit behind
   unresolvable GitBook file tags; deferred (Checkout already covers all
   banks). Provider interface stays ready.
5. **BRI VA response field** — a static VA is promised per sub-account but no
   response field is named; the client reads `vaNumber`/`virtualAccountNo`
   defensively and leaves it null otherwise.
6. **Limits, PG fees, settlement delay, rate limits, capacity** — no public
   numbers; enforce nothing locally (except our own fee policy + the
   Rp100.000 NET checkout minimum), surface
   DOKU errors verbatim. Settlement can lag payment by more than a day.
   100K–1M PID throughput needs explicit DOKU confirmation.
7. **Bank-code list / channel default** — transfer channel defaults to
   `BI_FAST` per docs; the full bank list lives behind the Kirim docs link.
8. **Unified Ledger is now IN scope** (was out of scope): `DOKU_NON_FIAT`
    top-up, `DOKU_SUB_ACCOUNT` + `POINT` P2P, POINT debit/cancel, and
    `topup/void` are implemented (see Money model). `DOKU_WALLET` stays out.
9. **Bank/e-wallet payouts deferred** — `BANK_ACCOUNT`/`DOKU_WALLET` removed
    from the transfer enum (Treasury payout included — designed redeemable,
    rail pending); legacy payout rows are display-only (confirm and
    retry are kind-guarded). Re-enable by restoring the enum values plus the
    `beneficiaryBankCode`/`channel` DTO fields, a payout UI, and the
    point-debit-first reserve flow.
