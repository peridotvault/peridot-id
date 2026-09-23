# Sandbox verification matrix — DOKU financial rail (real calls, no mocks)

Preconditions: Part A dossier answered; `DOKU_SYSTEM_POINT_ACCOUNT_NO` (and
later Treasury/pool IDs) set in the **sandbox** env only. All entities use
test PIDs/emails marked `sbx-verify-*`; journal rows carry
`source: sandbox-verify`. If any step fails for provider reasons: **stop at
that boundary**, record actual behavior in this file's results log, and do
not proceed to later steps.

Standard capture per step (evidence artifacts, stored with date + operator):
full request/response bodies, our `partnerReferenceNo` ↔ DOKU `referenceNo`,
`latestTransactionStatus` transitions with timestamps, webhook payloads
received, resulting `balance-inquiries` deltas, `transaction-history-list`
rows, idempotency probe (replay same ref → expect 409, single effect), and
one failure probe where specified.

## Step 1 — NON_FIAT TOPUP (issuance primitive)

1. `transfer-inquiry` `DOKU_NON_FIAT` / `POINT`, tiny amount (e.g. 1.000),
   to test sub-account A. Expect `referenceNo`; record 400-code if funding
   still missing (regression of 4004203 ⇒ back to Part A).
2. `transfer-payment` with that `referenceNo`. Then `transactions-status`
   until terminal.
3. Assert: A's POINT balance delta == amount exactly; merchant
   `DOKU_SYSTEM_POINT` went negative by the same amount.
4. Idempotency probe: re-send inquiry with the same `partnerReferenceNo`
   → expect 409 → corroborate → assert single credit.
5. Record: amount value format accepted (`"1000.00"`?), `fromAccount`
   override behavior (docs say ignored — confirm or record deviation),
   any issuance fee observed (must be zero unless DOKU states otherwise).

## Step 2 — POINT balance change accounting

1. Second top-up of a different amount to A. Assert cumulative deltas.
2. Record SYSTEM_POINT negative total == sum issued (backing boundary).

## Step 3 — POINT transfer A→B (P2P liability move)

1. Inquiry + payment `DOKU_SUB_ACCOUNT` / `POINT`, A→B, with fee-bearing
   gross (e.g. gross 40.000). Record holder-name flow and whether
   `beneficiaryBankCode` omission is accepted (our client omits it).
2. Assert: A −gross, B +net, history legs on both sides sharing
   `referenceNo`; no fiat account moved on either side.
3. Chain A→B→C→D with partials; assert per-owner balances at each hop.

## Step 4 — POINT debit/burn → SYSTEM_POINT

1. `debit` PURCHASE / `POINT` from B. Assert: B debited, `toAccount`
   auto-filled as SYSTEM_POINT (docs claim — verify or record deviation),
   SYSTEM_POINT credited (retired).
2. `debit/cancel` partial refund of the same debit. Assert new rows, original
   untouched (docs claim — verify).
3. Failure probe: debit exceeding balance → expect clean failure, no
   partial movement.

## Step 5 — IDR consolidation (pool funding primitive)

1. Fund test sub-account X with fiat (sandbox Checkout/VA per existing
   runbook) and wait out settlement, or use settled test funds.
2. `DOKU_SUB_ACCOUNT` **IDR** transfer X → designated Treasury/operating
   IDR account. Assert both IDR balances moved; POINT balances untouched.
3. If DOKU rejects/restricts this pattern in any way → **stop, file as
   blocker** (redemption liquidity depends on it). Record exact behavior.

## Step 6 — BANK_ACCOUNT payout (redemption leg)

Prerequisite: sandbox test beneficiary (per dossier §5 — if DOKU cannot
provide one, provisioning it is a prerequisite step recorded here, never
invented credentials).
1. Inquiry + payment `BANK_ACCOUNT` from the pool account: record bank code
   used, channel, min/max probed, fee observed and bearer, status lifecycle
   with timestamps, webhook sequence.
2. Failure probe: invalid bank code → expect clean 4xx, journal `failed`,
   zero money moved.
3. Assert payout ref determinism (`{RD}-PAY` retries reuse the ref).

## Step 7 — David test (end-to-end ownership → redemption)

Setup: A deposits → issue → A→B→C→D chain → original fiat settles (or
still pending — run once each way).
1. D (zero fiat in D's sub-account) redeems via saga: replay identifies D
   as claimant → burn D's PTS → consolidate from backing-rich account if
   pool short → payout from pool.
2. Assert: D's bank credited exact amount; D's PTS burned exactly once
   (extinguished, never re-credited); A's fiat never moved by the transfer
   chain; later settlement of A's deposit creates zero legs and reassigns
   nothing; aggregate backing reconciles per the invariant-2 formula.

## Evidence checklist (all required before enablement)

- [ ] Dated captures for steps 1–7 (requests, responses, refs, statuses).
- [ ] Webhook payload log for every event type observed.
- [ ] 409 idempotency proofs for top-up, P2P, payout refs.
- [ ] Failure-probe records (4004203 regression check, bad bank code,
      over-debit, duplicate delivery).
- [ ] Per-channel PG fees observed + bank-code/limit/fee table from DOKU.
- [ ] Reconciliation report over the sandbox entities: invariant-1 exact,
      invariant-2 with every nonzero gap mapped to a documented adjustment.
- [ ] Stop-at-boundary reports for anything unverifiable, quoting actual
      provider behavior (no inferred capabilities).

Results log: append dated entries below as verification proceeds.

### 2026-09-23 (prior session, scripts uncommitted)
- B2B auth OK; register OK (`SAC-2637-1790154532137`, all 3 accounts incl.
  POINT); balance-inquiries OK; `vaNumber` absent (defensive read correct).
- `DOKU_NON_FIAT` inquiry → `4004203 Source account not configured for
  TOPUP`. Dossier Part A raised from this result.
