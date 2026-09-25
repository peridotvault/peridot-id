# Future Unified Ledger (DOKU) — frozen, not removed

> Status: **FROZEN**. `PID_UNIFIED_LEDGER_ACTIVE=false`.
> Nothing in `apps/api/src/fiat/` was deleted or rewritten for the fiat-ledger
> phase. This doc records what exists, how to re-activate it, and how the
> current fiat ledger migrates back. See also `docs/FIAT_LEDGER.md`.

## What exists (untouched)

- Authority: DOKU Sub-Account V2. Local Postgres is journal + cache only.
- Models: `FiatProviderAccount` (1 PID → 1 sub-account), `FiatProviderTransaction`
  (immutable journal: `providerPaymentStatus` vs `providerStatus` vs
  `settlementStatus` vs `ledgerStatus`, `direction/sourceAccount/destAccount/
  entryGroup/replaySeq/extinguished`), `FiatWebhookEvent` (persist-first inbox),
  `FiatFeePolicy` (versioned; v5 = 0.1% min Rp100, no cap).
- Money: Checkout NET-in (min Rp100.000 NET, `gross = net + fee` charged at DOKU);
  POINT P2P GROSS-in (`transfer_internal` + `points_credit` mirror + `points_fee`
  to Treasury, group invariant `G == N + F`); spendable = `DOKU_MERCHANT_POINT`.
- Issuance gate (`issuePointsForDeposit`, backend-only, CI-guarded): payment
  confirmed (Checkout order SUCCESS + exact amount-match) → `PID_UNIFIED_LEDGER_ACTIVE`
  → `DOKU_SYSTEM_POINT_ACCOUNT_NO` configured → re-corroborate → `DOKU_NON_FIAT`
  top-ups `{ref}-PTS` (NET→user) + `{ref}-PTS-FEE` (FEE→Treasury).
- Replay: `apps/api/src/fiat/ledger-replay.ts` (`replayJournal`).
  Invariant-1 EXACT: `replay == live DOKU POINT`. Invariant-2: aggregate backing
  with explicit adjustments (PG `SETTLEMENT_FEE` observed, `PID_REDEMPTION_RESERVE_IDR`,
  Rp1×leg rounding). Unexplained gap → ALERT + redemption halt.
- Idempotency: `providerRef == partnerReferenceNo` (+ deterministic derived refs),
  409 → corroborate, `upsert` mirrors, webhook `externalId` unique, `withPidLocks`,
  `withRetry` (network/5xx/429 only).
- Withdrawal/redemption: code-complete but disabled (`PID_REDEMPTION_ENABLED=false`);
  VA rail disabled (`PID_VA_ISSUANCE_ENABLED=false`).

## Re-activation checklist (Phase 0 ops, with DOKU)

1. Verify `DOKU_NON_FIAT` TOPUP + `SYSTEM_POINT` funding live (merchant-profile
   balance inquiry); paste `DOKU_SYSTEM_POINT_ACCOUNT_NO`.
2. Flip `PID_UNIFIED_LEDGER_ACTIVE=true` only after step 1 is evidenced.
3. Run `POST /v1/fiat/sub-accounts/admin/sweep` (cron) until `pendingIssuance` empty
   and Invariant-1 holds per PID.
4. Keep `PID_VA_ISSUANCE_ENABLED=false` until PROVIDER-DEP-01 is resolved with
   sandbox evidence. Keep redemption off until the BANK_ACCOUNT path is verified.

## Migration back from the fiat ledger

1. Freeze the fiat ledger: `PID_FIAT_LEDGER_FROZEN=true` (new sends/issues rejected,
   reads stay). See `docs/FIAT_LEDGER.md` §5.
2. Snapshot per-PID outstanding from the internal journal → migration manifest
   (pid → amount, total, hash).
3. Re-issue each outstanding balance through the **existing** issuance path
   (`executePointTopup`-equivalent, `source=migration-internal-credit`,
   idempotency `MIG-<pid>-<manifestHash>`). No new DOKU logic needed.
4. Verify: Invariant-1 (POINT replay == live POINT) **and**
   `total migrated == fiat-ledger outstanding`. Sweep reports both rails during overlap.
5. Retire: `PID_FIAT_LEDGER_ENABLED=false` (journal stays read-only forever
   for audit). Internal journal rows are never deleted.
