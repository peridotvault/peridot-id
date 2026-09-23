# PRD v6 — Fiat Money Layer (DOKU ledger-first)

Status: **accounting foundation implemented; financial rail gated on DOKU.**
Parent: PRD_v5 (on-chain smart wallet) covers chain balances; this PRD covers
everything fiat: deposits, spendable balance, transfers, reconciliation, and
(future) withdrawals. One PeridotID → one fiat identity → one Saldo.

## 1. Objective

DOKU Sub-Account V2 is the **authoritative financial ledger** — fiat
(IDR/Pending accounts) and spendable balance (Unified Ledger POINT
accounts, 1:1 IDR peg). The app keeps an **immutable transaction journal**
only: references, statuses, idempotency keys, snapshots, read projections.
It never calculates or mutates an authoritative balance — every displayed
number comes from a live DOKU response; every movement is a DOKU call keyed
by a unique reference.

Official contracts only: `developers.doku.com/wallet-as-a-service/sub-account/sub-account-v2`
(register, balance-inquiries, transaction-history-list, transactions-status,
transfer-inquiry/payment, debit/cancel, split-rules), the account-management
and collect-and-route guides, and `developers.doku.com/accept-payments/doku-checkout`
(`POST /checkout/v1/payment`, non-SNAP signing). Nothing below is assumed
from unofficial sources.

## 2. Actors & user stories

- **User** — holds one Saldo. "I top up Rp100.000 and see Rp100.000 usable
  in seconds." "I send Rp40.000 to `rani@pid` and see my new balance plus a
  receipt." "I withdraw to my bank and see Processing → Completed."
- **Treasury (platform)** — earns the flat 5% fee as redeemable points;
  funds bank payouts from pooled fiat liquidity. Never a user-visible actor.
- **Ops/admin** — provisions hierarchy once, runs sweeps/backfills,
  reviews `manualReview` queues and halt states, reads the journal.
  All money tools live behind `AdminGuard`; none exist in the wallet.
- **DOKU (provider)** — ledger of record for fiat and points; source of
  webhooks, settlement timing, PG fees, and bank rails.

Non-stories (explicitly out): product-specific balances (one Saldo per PID
across all products), user-visible ledger mechanics, application-side
balance simulation.

## 3. Core model

### 3.1 Hierarchy (no product parents)

```
Peridot ID (Main Merchant, root)
├── Users (parent Sub-Account for EVERY PID financial account)
│   ├── <pid-A> Sub-Account   (1 PID = 1 User Sub-Account)
│   └── …
└── Treasury (system Sub-Account — NOT under Users)
```

`Users` and Treasury are provisioned once, manually, via the DOKU
dashboard (`DOKU_USERS_PARENT_PROFILE_ID`, `DOKU_TREASURY_PROFILE_ID` /
`DOKU_TREASURY_ACCOUNT_NO`). `registerAccount` creates each PID account as
a child of `Users`. Never hierarchy-by-product.

### 3.2 Money

- **Spendable Saldo = live `DOKU_MERCHANT_POINT` available, 1:1 IDR peg.**
- Checkout deposits are **NET-in** (min Rp100.000 NET, API-enforced):
  `fee = flat 5% of net` (half-up, no cap), `gross = net + fee`.
- **Issuance (backend-only):** on corroborated payment the backend issues
  two `DOKU_NON_FIAT` top-ups from `DOKU_SYSTEM_POINT`: `{ref}-PTS` (NET →
  user) and `{ref}-PTS-FEE` (FEE → Treasury, redeemable). Unique refs → no
  double issue; 409 → corroborate-and-adopt. No route/SDK/screen can issue
  (CI-guarded).
- **Amount-match gate:** corroborated paid amount must equal the
  server-created invoice gross, else `ledgerStatus: blocked` for ops review.
- **Fiat settlement = backing, never a credit.** Checkout fiat settles 100%
  to the user IDR account (no fiat split — that would double-charge).
  Separate columns: `providerStatus` (payment), `ledgerStatus`
  (`pending → issued | partial | failed | blocked | clawed_back`),
  `settlementStatus` (`pending → settled`).
- **Transfers are POINT P2P**, recipient addressed by PID (server-resolved).
  GROSS-in; NET to recipient, FEE to Treasury (`{ref}-PTFEE`).
- **Clawbacks** (failed/charged-back after issue): POINT debit (partial,
  retry-safe, `{parent}-CLAWBACK-{n}`), admin-triggered. Void-topup only
  for full-exact reversals (non-idempotent by DOKU design).
- VA deposits: same issuance path after corroboration; below-minimum-net
  flagged, funds preserved.
- Every movement carries source, destination, amount, currency, DOKU ref,
  status, timestamp, and idempotency key in the journal.

### 3.3 Double-entry PTS journal & invariants

Every PTS movement is a balanced leg set sharing an `entryGroup`, folded in
`replaySeq` order by the pure `replayJournal`
(`apps/api/src/fiat/ledger-replay.ts` — same function recon and tests use):

- Issuance: `points_issue` (in, user) + `points_fee` (treasury). Deposit
  parents are fiat intent — never PTS value.
- P2P (gross G, fee F, net N): parent `transfer_internal` (out, G) +
  `points_credit` mirror (in, N, keyed by DOKU's `referenceNo`) +
  `points_fee` (treasury, in, F). G == N + F per group, enforced by replay.
- Clawback: `points_clawback` (out). Redemption burn: `points_redeem`
  (out, `extinguished=true` — burned units can never be re-credited).
- Legacy IDR-era rows and fiat-intent kinds are skipped (counted, never
  valued). Only `settled` rows count; the rest is in-flight.
- Ownership vs fiat location are fully separated: after
  Alice→Bob→Charlie→David, fiat may sit in Alice's sub-account while David
  owns the claim — replay answers ownership from the journal alone.

1. **Ledger integrity (EXACT):** `replay(journal) == live DOKU POINT
   balances`, per PID and platform-wide. Any mismatch is a P0 alert.
2. **Aggregate backing (explained-difference only):** total outstanding
   redeemable PTS vs total fiat (`available + pending`, all user + Treasury
   accounts) plus an explicit adjustment ledger (documented PG fees,
   reserves, refunds, chargebacks). Every nonzero gap must map to an
   adjustment row; the only allowance is documented per-leg rounding
   (`|gap| ≤ Rp1 × legs since last clean close`, each use citing the DOKU
   behavior). Unexplained difference → alert and stop redemption. No
   percentage tolerance. Per-PID fiat gaps are info-only.
- Settlement flips `settlementStatus` only — never creates legs.
- Same-PID movements serialize via in-process pid locks (sender+recipient
  sorted for P2P); DOKU remains the final arbiter; every retry reuses refs.

### 3.4 Safety rules (binding on implementation)

- Row-before-call with unique `providerRef`; inquiry and payment share one
  `partnerReferenceNo`; register inserts `creating` first (no blind retry).
- Retry transient faults only (network/5xx/429, backoff+jitter); 4xx never
  retried; 429 → 503; 409 → corroborate, don't resend.
- Strict integer-IDR parsing at the boundary; unparseable rows flagged,
  never zeroed.
- Webhooks are unsigned hints: persist on `X-EXTERNAL-ID`, corroborate via
  `transactions-status`, apply only on corroboration.
- B2B token in backend memory only; no secrets in any table.
- `balance = Σ(status ≠ VOID)`; reconciliation completes issuance, backfills
  missed deposits, marks settlement, flags `belowMinimumNet`, reports
  `pendingIssuance`/gap/PG/drift. Double issuance impossible by
  construction. Bounded admin sweep instead of daemons; history pages capped.
- Env: `DOKU_MODE/CLIENT_ID/SECRET_KEY/PRIVATE_KEY` (+ `DOKU_SAC_TYPE`,
  `DOKU_USERS_PARENT_PROFILE_ID`, `DOKU_TREASURY_PROFILE_ID`,
  `DOKU_TREASURY_ACCOUNT_NO`, `DOKU_TREASURY_POINT_ACCOUNT_NO`,
  `DOKU_SYSTEM_POINT_ACCOUNT_NO`, `DOKU_WEBHOOK_URL`,
  `DOKU_CHECKOUT_NOTIFY_URL`, `PID_REDEMPTION_ENABLED=false`,
  `PID_REDEMPTION_RESERVE_IDR=0`).

## 4. Core flows

- **Deposit:** login → `POST accounts` → `POST deposits/checkout {net ≥
  100000}` → DOKU-hosted page (charged gross) → paid webhook → persist →
  corroborate → amount-match → issue NET + FEE points → Saldo usable in
  seconds → fiat settles later as backing-only.
- **Transfer:** `POST transfers/inquiry {beneficiaryPid}` (quote) →
  `/confirm` → NET points P2P + FEE to Treasury + recipient mirror →
  receipt. Serialized per sender+recipient.
- **Settlement:** history legs flip `settlementStatus`; create nothing.
- **Redemption (flagged off):** replay identifies claimant → `redemption`
  parent (`requested`) → `points_redeem` burn (`{RD}-BURN`, extinguished
  only when settled) → pool liquidity (claimant-local first, then journaled
  `fiat_consolidation`) → `{RD}-PAY` `BANK_ACCOUNT` payout → `completed`.
  Burn-without-payout resumes same-ref via sweep; requested-without-burn
  older than 15 min expires and releases.

## 5. UX specification (binding)

User screens show **Balance, Deposit, Transfer, Withdraw** only, with states
**Processing / Completed / Failed**. Banned from user UI: PTS, DOKU ledger,
pending, settlement, backing, SYSTEM_POINT, reconciliation, split,
mirror, clawback, and any Sub-Account terminology. All of those live in
admin/debug interfaces only. No Withdraw surface exists while
`PID_REDEMPTION_ENABLED=false`; the minimal Withdraw flow (available
Balance, bank destination, amount, statuses) ships at enablement.
Bank-account management, limits education, and advanced UX are a later
phase after the rail is proven.

## 6. Requirements (acceptance — all boxes ticked with evidence)

| # | Criterion | How proven | Status |
|---|---|---|---|
| 1 | No POINT↔journal discrepancy | Invariant-1 exact, every lifecycle stage, sandbox entities | ☐ |
| 2 | No double issuance | Duplicate webhook + duplicate issue runs; ref-uniqueness audit | ☐ |
| 3 | No double fee | Treasury legs reconciled per group `G == N + F`; no fiat split active | ☐ |
| 4 | No settlement-created PTS | Settlement-history replay produces zero new legs | ☐ |
| 5 | No double burn | Burn-ref uniqueness; extinguished-once assertion | ☐ |
| 6 | No payout without extinguished liability | Payout leg requires settled burn row (negative test included) | ☐ |
| 7 | No stranded extinguished liability | Every burn resolves to payout-completed or recoverable sweep state; sweep report has zero criticals | ☐ |
| 8 | Aggregate backing reconciles | Invariant-2 formula; every nonzero gap mapped to the adjustment ledger | ☐ |
| 9 | David redeems with zero local fiat | Bank credited exact, burn-once, A-fiat untouched, later settlement creates nothing | ☐ |
| 10 | Failed payout / crash recovery | Kill between burn and payout → sweep completes same-ref payout; requested-without-burn expires and releases | ☐ |
| 11 | Refund/chargeback after issue | Clawback legs; outstanding and backing move together | ☐ |
| 12 | UI exposes only Balance/Deposit/Transfer/Withdraw | Review per §5 | ☐ |

Mocked suites are regression gates, never acceptance evidence.

## 7. DOKU dependency (forwardable — send as-is to DOKU)

Status: **NOT SENT.** Nothing proceeds past corroborated-read behavior
until every item is answered AND verified live. Code gates on the
capability being activated and verified, never on this section being sent.

- **Context:** PeridotID gaming wallet; backend orchestrates Sub-Account V2
  as authoritative ledger (fiat) + Unified Ledger (POINT, 1:1 peg).
  Sandbox creds working (B2B auth, register, balance OK — Sep 2026).
  Blocker: `DOKU_NON_FIAT` transfer-inquiry returns **`4004203 Source
  account not configured for TOPUP`**. Posture: DOKU is ledger of record;
  unavailable funding surfaces as retryable/deferred, never as issued value.
- **Ask 1 — Activate Unified Ledger (sandbox first):** Dashboard →
  Settings → Service → + Add Service → Wallet as a Service → Unified
  Ledger (or confirm the provisioning path if not self-service). Confirm in
  writing; repeat for production only after sandbox verification passes.
- **Ask 2 — Confirm/provision `DOKU_SYSTEM_POINT_ACCOUNT_NO`:** exact
  number for sandbox then production, plus: (a) auto-created on activation
  or separate request? (b) funding semantics — negative permitted?
  floor/limit? collateral/pre-funding (instrument, minimum, ops top-up)?
  per-tx/daily issuance limits? TOPUP accounting (negative entry only vs
  clearing against fiat)? issuance fees? (c) exact pre-ready error
  behavior to distinguish "not provisioned" from other failures.
- **Ask 3 — BANK_ACCOUNT payout requirements:** exact bank-code list +
  source of truth; min/max per transfer and daily, per-channel
  (`BI_FAST`/`ONLINE`) cutoffs, fee schedule + bearer; debit-vs-credit
  timing, `latestTransactionStatus` lifecycle, webhook sequence;
  idempotency confirmation (409, status-authoritative recovery); sandbox
  test-beneficiary procedure (if unavailable, say so — provisioning it
  becomes our prerequisite; we invent no credentials).
- **Ask 4 — IDR consolidation:** confirm ordinary `DOKU_SUB_ACCOUNT` IDR
  transfers from backing-rich sub-accounts into a Treasury/operating IDR
  account are supported (limits, approval, hierarchy constraints); or
  specify a dedicated pool account type and its provisioning.
- **Ask 5 — Adjustment schedules:** per-channel PG-fee schedule,
  settlement-fee behavior, refund/chargeback shapes and timelines, any
  reserves/holds. Every nonzero backing gap must map here — no percentage
  tolerance will be used.
- **What we send back:** dated captures, refs, status transitions, webhook
  payloads, zero-unexplained-discrepancy recon report — or a stop-at-boundary
  report quoting actual behavior. Sandbox-only, marked entities, never mixed
  with real users.

## 8. Verification matrix (real calls, no mocks — strict order)

Preconditions: §7 answered; `DOKU_SYSTEM_POINT_ACCOUNT_NO` (+ Treasury/pool
IDs) in **sandbox** env only; entities marked `sbx-verify-*`; journal
`source: sandbox-verify`. Any provider failure: **stop at that boundary**,
record actual behavior below, do not proceed.

Standard capture per step: full request/response bodies, our
`partnerReferenceNo` ↔ DOKU `referenceNo`, status transitions with
timestamps, webhooks received, `balance-inquiries` deltas, history rows,
idempotency probe (same ref → 409, single effect), one failure probe where
specified.

1. **NON_FIAT TOPUP:** inquiry + payment (e.g. 1.000) → status until
   terminal. Assert POINT delta exact + SYSTEM_POINT negative mirror.
   Idempotency probe. Record amount format, `fromAccount` override
   behavior, issuance fees (zero unless stated). 4004203 regression ⇒ back
   to §7.
2. **Balance accounting:** second top-up, different amount; cumulative
   deltas; SYSTEM_POINT total == sum issued.
3. **P2P A→B:** fee-bearing gross (e.g. 40.000); holder-name flow;
   `beneficiaryBankCode` omission accepted? Assert A −gross, B +net, shared
   `referenceNo` legs, no fiat moved. Then A→B→C→D partials.
4. **Debit/burn → SYSTEM_POINT:** PURCHASE/POINT; `toAccount` auto-filled?
   SYSTEM_POINT credited? Partial `debit/cancel` (new rows, original
   untouched)? Over-debit failure probe (clean, no partial move).
5. **IDR consolidation:** fund X, settle, transfer X → Treasury IDR.
   Assert both moved, POINT untouched. Any restriction ⇒ stop, file blocker.
6. **BANK_ACCOUNT payout:** from pool; record code/channel/min-max/fee/
   lifecycle/webhooks; invalid-code failure probe (clean 4xx, zero moved);
   `{RD}-PAY` ref determinism.
7. **David test:** A deposits → issue → chain → D redeems with zero local
   fiat → consolidate if pool short → pool payout. Assert exact bank
   credit, burn-once, A-fiat untouched, later settlement creates nothing,
   aggregate backing per §3 formula.

Evidence checklist (all required before enablement):

- [ ] Dated captures steps 1–7 (requests, responses, refs, statuses).
- [ ] Webhook payload log for every event type observed.
- [ ] 409 idempotency proofs (top-up, P2P, payout refs).
- [ ] Failure probes (4004203 regression, bad bank code, over-debit,
      duplicate delivery).
- [ ] PG fees observed + bank-code/limit/fee table from DOKU.
- [ ] Recon report: invariant-1 exact, invariant-2 fully mapped.
- [ ] Stop-at-boundary reports for anything unverifiable (actual behavior
      quoted, nothing inferred).

Results log (append dated entries):

- 2026-09-23 — B2B auth OK; register OK (`SAC-2637-1790154532137`, all 3
  accounts incl. POINT); balance-inquiries OK; `vaNumber` absent (defensive
  read correct). `DOKU_NON_FIAT` inquiry → `4004203`. Dossier raised.

## 9. Open blockers (stopped here, not guessed)

0. **Unified Ledger activation (VERIFIED live blocker)** — see §7.
0b. **Payout liquidity path (unverified)** — `BANK_ACCOUNT` documented but
    bank codes (Kirim docs), min/max, fees, callbacks, and pool/JIT
    consolidation acceptance unconfirmed. Redemption stays flagged until
    §8 passes plus a zero-discrepancy recon.
1. **Fiat split rule retired** — fees move as Treasury POINTS; no fiat
    split on payments (double charge). `admin/split-rules` passthrough is
    future-use only; rule list/get/update/delete undocumented.
2. **Checkout `additional_info.account` casing** — camelCase in SAC guide
    vs snake_case in Checkout schema; implemented snake_case
    (`CHECKOUT_SAC_ACCOUNT_KEY`); sandbox-verify (invalid ids fail silently).
3. **Checkout notify payload shape** — mitigated via corroboration on the
    invoice number before any state change.
4. **Per-channel Direct API schemas** — GitBook file tags unresolvable;
    deferred (Checkout covers all banks); provider interface ready.
5. **BRI VA response field** — promised per sub-account, unnamed in
    responses; client reads `vaNumber`/`virtualAccountNo` defensively.
6. **Limits, PG fees, settlement delay, rate limits, capacity** — no public
    numbers; enforce only our fee policy + Rp100.000 NET minimum; surface
    DOKU errors verbatim. Settlement can lag > a day. 100K–1M PID needs
    DOKU confirmation.
7. **Bank-code list / channel default** — `BI_FAST` default; full list
    behind Kirim docs link.
8. **Unified Ledger scope** — `DOKU_NON_FIAT`, P2P+POINT, POINT debit/cancel,
    `topup/void` implemented. `DOKU_WALLET` out.
9. **Bank/e-wallet payouts deferred** — `BANK_ACCOUNT`/`DOKU_WALLET` out of
    the transfer enum; legacy payout rows display-only. Re-enable with enum
    values + `beneficiaryBankCode`/`channel` DTO fields + payout UI +
    point-debit-first reserve flow.

## 10. Rollout plan

1. All §6 rows pass with linked evidence; §8 checklist complete; §7
   answers recorded.
2. Existing users backfilled/audited; sweep clean for one full settlement
   cycle.
3. Pool/Treasury/SYSTEM_POINT IDs in deploy env; flip
   `PID_REDEMPTION_ENABLED=true` one environment at a time.
4. Minimal Withdraw flow per §5; bank-account management, limits education,
   advanced UX deferred.
5. Rollback: flag back (in-flight sagas complete via sweep); any invariant
   breach re-triggers the stop rule.

## References

- PRD_v5 (on-chain smart wallet — chain balances; fiat lives here in v6)
- WHITEPAPER.md (canonical contracts spec)
- OpenAPI spec (`packages/openapi/src/openapi.yaml`, source of truth)
- Journal replay (`apps/api/src/fiat/ledger-replay.ts`, same function recon
  and tests use)
