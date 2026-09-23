# Redemption acceptance matrix — enable withdrawals only when all rows pass

`PID_REDEMPTION_ENABLED` stays `false` until every row below passes against
**real DOKU sandbox behavior** (Part B matrix) plus the readiness exercise.
Mocked suites are regression gates, never acceptance evidence. Any row that
cannot be verified stops enablement at that boundary.

## Reconciliation policy (binding — replaces percentage tolerance)

- **Invariant 1 (exact, zero tolerance):**
  `replay(journal) == live DOKU POINT balances`, per PID and platform-wide.
  Any nonzero difference is a P0 alert and blocks redemption. No tolerance.
- **Invariant 2 (explained-difference only):**
  Let `O` = total outstanding redeemable PTS (replay, extinguished excluded),
  `B` = aggregate DOKU fiat backing (`available + pending` over all user +
  Treasury IDR accounts), and `A` = sum of explicitly modeled adjustments,
  each with its own evidence row (see table). Define
  `gap = O − B − A`. **Accept iff `gap == 0` after rounding.**
- **Rounding rule (the only tolerance):** DOKU amounts carry 2 decimals;
  our journal is whole-IDR. Per leg, at most Rp1 of representation drift is
  possible and only where a documented DOKU behavior requires it (currently:
  none confirmed — PG fees observed so far are whole-IDR). Formula:
  `|gap| ≤ Rp1 × (number of legs settled since last clean close)`, and any
  use of this allowance must cite the specific DOKU behavior. Anything
  beyond it is unexplained → **alert and stop redemption** (disable flag,
  freeze new redemptions; in-flight sagas complete via sweep).
- A percentage-of-outstanding tolerance must never be used: it scales the
  permitted error with volume and can mask a real accounting break.

## Adjustment ledger (every row needs evidence; no catch-alls)

| Adjustment | Sign | Evidence required |
|---|---|---|
| Documented PG channel fees deducted pre-settlement | reduces B | DOKU fee schedule + observed `SETTLEMENT_FEE` history rows |
| Reserves/holds (if DOKU imposes any) | reduces B | DOKU statement of reserve terms + observed held amounts |
| Refunds issued to users | reduces O | refund journal legs + DOKU corroboration |
| Chargebacks absorbed | reduces O or B | provider notification + clawback legs |
| Rounding allowance (above) | ±Rp1/leg | cited DOKU behavior per use |

## Acceptance rows

| # | Criterion | How proven | Status |
|---|---|---|---|
| 1 | No POINT↔journal discrepancy | Invariant-1 exact, every lifecycle stage, sandbox entities | ☐ |
| 2 | No double issuance | Duplicate webhook + duplicate issue runs; ref-uniqueness audit | ☐ |
| 3 | No double fee | Treasury legs reconciled per group `G == N + F`; no fiat split active | ☐ |
| 4 | No settlement-created PTS | Settlement-history replay produces zero new legs | ☐ |
| 5 | No double burn | Burn-ref uniqueness; extinguished-once assertion | ☐ |
| 6 | No payout without extinguished liability | Payout leg requires settled burn row (negative test included) | ☐ |
| 7 | No stranded extinguished liability | Every burn resolves to payout-completed or recoverable sweep state; sweep report has zero criticals | ☐ |
| 8 | Aggregate backing reconciles | Invariant-2 formula above; every nonzero gap mapped to the adjustment ledger | ☐ |
| 9 | David redeems with zero local fiat | Matrix step 7: bank credited exact, burn-once, A-fiat untouched, later settlement creates nothing | ☐ |
| 10 | Failed payout / crash recovery | Kill between burn and payout → sweep completes same-ref payout; requested-without-burn expires and releases | ☐ |
| 11 | Refund/chargeback after issue | Clawback legs; outstanding and backing move together | ☐ |
| 12 | UI exposes only Balance/Deposit/Transfer/Withdraw | Review: no PTS/DOKU/settlement/backing/SYSTEM_POINT/reconciliation terminology in user screens | ☐ |

## Enablement procedure (minimal)

1. All rows above pass; evidence checklist in `SANDBOX_VERIFICATION_MATRIX.md`
   complete; Part A answers recorded.
2. Existing users backfilled/audited; sweep reports clean for one full
   settlement cycle.
3. Set pool/Treasury/SYSTEM_POINT IDs in deploy env; flip
   `PID_REDEMPTION_ENABLED=true` one environment at a time.
4. Expose only the simple Withdraw flow (available Balance, bank
   destination, amount, Processing/Completed/Failed). Bank-account
   management, limits education, and advanced UX are a separate later phase.
5. Rollback: flip the flag back (in-flight sagas complete via sweep; no new
   redemptions start). Any invariant breach post-enable re-triggers the
   stop rule above.
