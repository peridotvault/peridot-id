# TTL-Cron Ops + OQ-2 Rent Methodology (Stellar Phase-1 P1, ANT-703)

Testnet-only. Mainnet out of scope (ANT-542 G10 stays CLOSED).

## 1. Cron skeleton

Off-chain scheduler (Trevor/Troy P1). Decision logic lives in
`contracts/stellar/src/fees.rs` (`should_bump`, `BumpSet::plan_bump`,
`CronState`); the scheduler, RPC reads, and signing live outside the crate.

- **Cadence:** ≥ 1 run / 24h (`CRON_MAX_INTERVAL_SECS = 86_400`).
- **Read:** `getLedgerEntries` → `live_until_ledger_seq` for every pilot
  entry: account instance + `ContextRuleData(*)` + signer/policy entries,
  **including every G2 snapshot row**. The entry list is derived from the
  indexer each run and reconciled (count change ⇒ alert — entry-set drift
  would otherwise silently archive subsets).
- **Bump rule:** if `remaining < 17_000` ledgers (`BUMP_THRESHOLD_LEDGERS`,
  ≈48h-equivalent), submit persistent `extend_ttl` to max.
- **Version pin:** the bump set carries the indexer's list version
  (`BumpSet.version`). A run holding a stale version aborts the bump and
  re-fetches (`plan_bump` returns `None`) — same fail-closed shape as
  `StaleSnapshot`. Never bump a stale set.
- **Signer:** dedicated bump-only signer. No rule rights, no session
  authority. The cron NEVER signs intents.
- **Paging:** 3 consecutive bump failures page (`CronState::needs_page`,
  MTTR ≤ 15 min per spec §4.5).
- **NFRs:** quote p95 ≤ 3s; bump cost ≤ 2× typical `total_fee`
  (typical all-in ≈ 322_500 stroops per `fees.rs` tests).

## 2. OQ-2 rent methodology (steady-state)

Phase-0 shapes cannot yield steady-state (fresh entries, no aging — Exp-3
numbers are the baseline row, not the answer). Requires the P1 pilot shape.

1. Deploy pilot-shape account: factory account + ≥ 1 rule + G2 snapshot entries.
2. `simulateTransaction` at TTL 100% / 50% / 10% remaining → record
   `rent` / `restore` lines (explicit-zero when absent — R6 join rule, never
   absent-vs-zero ambiguity).
3. Extend to max; idle 7 days under the cron; re-simulate.
4. Steady-state = `rent_fee`/day at full-bump cadence + `restore_fee`
   (expected 0 while cron healthy).
5. **Restore drill (once):** let one non-critical entry archive, restore it,
   record the non-zero `restore_fee` path cost.
6. Report table joins the baseline row (Exp-3: all-in 225425-quoted /
   106132-charged, non-refundable 8999 archival rent inside resource fee)
   with the 7-day projection in stroops + XLM.

Success bar: bump cost ≤ 2× typical `total_fee`; 7-day projection table with
explicit-zero lines.

## 3. Testnet follow-ups (not in this change)

- [ ] Scheduler deployment + bump-only signer provisioning (Trevor).
- [ ] Restore drill execution + cost recorded (Troy, needs testnet).
- [ ] 7-day steady-state table (needs pilot shape + cron running).
- [ ] Q1 gate: reconcile cron spend vs projection within drift.
