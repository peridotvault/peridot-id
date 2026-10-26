//! Experiment 3: relayer-as-source sponsorship loop (stroops).
//!
//! Stellar cannot observe the fee the source paid from inside the contract
//! (same accepted limitation as SVM): the backend attests the fee, the
//! contract recomputes `protocol_fee` from policy, and reconciliation checks
//! `feeCharged` from RPC meta afterwards.
//!
//! Policy (ANT-542 G2/D2 + Theo spec ANT-553, ACCEPTED — fees CONFIRMED
//! as-is, R6 revises the drift gate to ALL-IN totals): `protocol_fee =
//! MAX(50% network, 0.01 XLM floor)`; `total = network + protocol`
//! (saturating); the user authorizes `max_total_fee` in the signed payload.
//!
//! Rules ported from the whitepaper: drift `attested_total*100 >
//! quoted_total*120` rejects on ALL-IN totals (quote lines: network_fee +
//! rent_fee + restore_fee + protocol_fee); TTL ≤ 600s maps to ledgers at
//! ~5s/ledger (never ledger-TTL-as-auth: enforced expiry + per-session seq
//! in contract state, mirrored here as explicit `expiry_ledger` +
//! `session_seq` inputs).

/// Stroops per XLM.
pub const STROOPS_PER_XLM: u64 = 10_000_000;
/// 0.01 XLM minimum protocol fee, in stroops. Binds on cheap calls.
pub const MIN_PROTOCOL_FEE_STROOPS: u64 = 100_000;
/// Fee policy v1: 5000 bps (50%). `MAX_PROTOCOL_FEE_BPS = 5000`.
pub const PROTOCOL_FEE_BPS_V1: u64 = 5000;
pub const MAX_PROTOCOL_FEE_BPS: u64 = 5000;
/// Quote drift bound: reject submit when `attested*100 > quoted*120`.
pub const DRIFT_NUM: u128 = 120;
pub const DRIFT_DEN: u128 = 100;
/// Max intent TTL: 600s, ≈120 ledgers at ~5s/ledger.
pub const MAX_TTL_SECS: u64 = 600;
pub const LEDGER_SECS: u64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeError {
    UnknownFeePolicy,
    ExceedsMaxBps,
    DriftExceeded,
    ExceedsUserMax,
    InsufficientFunds,
}

pub fn policy_protocol_bps(fee_policy_version: u16) -> Result<u64, FeeError> {
    match fee_policy_version {
        1 => Ok(PROTOCOL_FEE_BPS_V1),
        _ => Err(FeeError::UnknownFeePolicy),
    }
}

/// `protocol_fee = MAX(floor(network_fee * bps / 10_000), 0.01 XLM)`.
/// Floor favors the user (rounds down before the max, never up).
pub fn protocol_fee(network_fee: u64, bps: u16) -> Result<u64, FeeError> {
    if (bps as u64) > MAX_PROTOCOL_FEE_BPS {
        return Err(FeeError::ExceedsMaxBps);
    }
    let share = (network_fee as u128 * bps as u128 / 10_000) as u64;
    Ok(share.max(MIN_PROTOCOL_FEE_STROOPS))
}

pub fn total_fee(network_fee: u64, protocol_fee: u64) -> u64 {
    network_fee.saturating_add(protocol_fee)
}

/// All-in total: network + rent + restore + protocol (saturating).
pub fn all_in_total(network_fee: u64, rent_fee: u64, restore_fee: u64, protocol_fee: u64) -> u64 {
    network_fee
        .saturating_add(rent_fee)
        .saturating_add(restore_fee)
        .saturating_add(protocol_fee)
}

/// Drift gate (generic over all-in totals, Theo R6): `true` when the
/// attested all-in total is within 120% of the quoted all-in total.
pub fn within_drift(quoted_total: u64, attested_total: u64) -> bool {
    (attested_total as u128) * DRIFT_DEN <= (quoted_total as u128) * DRIFT_NUM
}

/// Itemized quote (Theo spec §4.1, contract-first). Zero lines are explicit,
/// never absent — reconciliation joins on line presence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quote {
    pub network_fee: u64,
    pub rent_fee: u64,
    pub restore_fee: u64,
    pub protocol_fee: u64,
    pub total_quoted: u64,
    pub quoted_at_ledger: u32,
    /// Validity window in ledgers (≤ 120).
    pub valid_for_ledgers: u32,
}

/// Build a quote from an RPC simulation: `minResourceFee` + `rent`/`restore`
/// lines. Protocol is computed on `network_fee` only (§3); the drift gate
/// and the user cap apply to the ALL-IN total (R6).
pub fn build_quote(
    network_fee: u64,
    rent_fee: u64,
    restore_fee: u64,
    fee_policy_version: u16,
    quoted_at_ledger: u32,
) -> Result<Quote, FeeError> {
    let bps = policy_protocol_bps(fee_policy_version)?;
    let protocol = protocol_fee(network_fee, bps as u16)?;
    Ok(Quote {
        network_fee,
        rent_fee,
        restore_fee,
        protocol_fee: protocol,
        total_quoted: all_in_total(network_fee, rent_fee, restore_fee, protocol),
        quoted_at_ledger,
        valid_for_ledgers: 120,
    })
}

/// Full sponsorship check on all-in totals, in quote→attest order (checks
/// before effects): drift → policy → user cap → balance.
/// Returns `(protocol_fee, attested_all_in_total)`.
pub fn check_sponsored(
    quoted: &Quote,
    attested_network_fee: u64,
    attested_rent_fee: u64,
    attested_restore_fee: u64,
    fee_policy_version: u16,
    max_total_fee: u64,
    balance: u64,
) -> Result<(u64, u64), FeeError> {
    let bps = policy_protocol_bps(fee_policy_version)?;
    let protocol = protocol_fee(attested_network_fee, bps as u16)?;
    let attested_total = all_in_total(
        attested_network_fee,
        attested_rent_fee,
        attested_restore_fee,
        protocol,
    );
    if !within_drift(quoted.total_quoted, attested_total) {
        return Err(FeeError::DriftExceeded);
    }
    if attested_total > max_total_fee {
        return Err(FeeError::ExceedsUserMax);
    }
    if balance < attested_total {
        return Err(FeeError::InsufficientFunds);
    }
    Ok((protocol, attested_total))
}

/// Reconciliation adapter input: RPC `feeCharged` (plus `rent_fee` /
/// `restored` lines) vs attested. The relayer absorbs spike underpayment;
/// a mismatch beyond drift raises an alert (returned as `false`).
pub fn reconcile_fee_charged(attested_network_fee: u64, fee_charged: u64) -> bool {
    within_drift(attested_network_fee.min(fee_charged), attested_network_fee.max(fee_charged))
        || fee_charged <= attested_network_fee
}

/// TTL seconds → ledgers (ceil). Callers MUST ALSO enforce a per-session
/// `seq`/expiry in contract state — ledger arithmetic is transport, not auth.
pub fn ttl_secs_to_ledgers(ttl_secs: u64) -> u64 {
    ttl_secs.div_ceil(LEDGER_SECS)
}

// ── TTL-cron steady-state policy (Phase-1 P1, ANT-703 — TTL-cron + OQ-2) ──
//
// Off-chain cron skeleton (pure decision logic; the scheduler, RPC reads,
// and the bump signer live outside this crate):
// - Cadence ≥ 1 run/24h ([`CRON_MAX_INTERVAL_SECS`]); each run reads
//   `live_until_ledger_seq` for every pilot entry via `getLedgerEntries`.
// - Bump when remaining < ~17k ledgers ([`BUMP_THRESHOLD_LEDGERS`],
//   ≈48h-equivalent) with a persistent `extend_ttl` to max.
// - Dedicated bump-only signer (no rule rights, no session authority);
//   the cron NEVER signs intents.
// - Page after [`CRON_MAX_CONSECUTIVE_FAILURES`] consecutive failures.
// - The bump entry set is version-pinned ([`BumpSet`]): entry-set drift
//   (new rule/snapshot entries missing from the list ⇒ silent archival of
//   subsets) fails loudly instead of silently — the indexer owns the list
//   and bumps its version; a run against a stale version aborts the bump
//   (same fail-closed shape as `StaleSnapshot`).
//
// OQ-2 rent methodology (testnet): (1) deploy the pilot-shape account
// (factory account + ≥1 rule + snapshot entries); (2) `simulateTransaction`
// at TTL 100%/50%/10% remaining, recording `rent`/`restore` lines;
// (3) extend to max, idle 7 days under the cron, re-simulate; steady-state
// = `rent_fee`/day at full-bump cadence + `restore_fee` (expected 0 while
// the cron is healthy; one archival-restore drill measures the non-zero
// path). Success bar: bump cost ≤ 2× typical `total_fee`; 7-day projection
// in stroops + XLM. See `TTL_CRON.md` for the runbook.

/// Bump when an entry has fewer than this many ledgers of TTL remaining
/// (≈48h at ~5s/ledger — the spec §4.5 "~17k ledgers" threshold).
pub const BUMP_THRESHOLD_LEDGERS: u32 = 17_000;

/// Maximum interval between cron runs (≥ 1 run/24h).
pub const CRON_MAX_INTERVAL_SECS: u64 = 86_400;

/// Consecutive bump failures before paging (MTTR ≤ 15 min per spec §4.5).
pub const CRON_MAX_CONSECUTIVE_FAILURES: u32 = 3;

/// True when an entry's remaining TTL needs a bump this run.
pub fn should_bump(remaining_ledgers: u32) -> bool {
    remaining_ledgers < BUMP_THRESHOLD_LEDGERS
}

/// Version-pinned bump entry set. `expected_version` is the indexer's
/// current version; a run holding a stale list must abort (fail-closed).
#[derive(Debug, Clone)]
pub struct BumpSet {
    pub version: u32,
    /// Entry hashes (account instance + `ContextRuleData(*)` + signer/policy
    /// entries, including every G2 snapshot row) to `extend_ttl`.
    pub entries: Vec<[u8; 32]>,
}

impl BumpSet {
    /// Entries to bump this run: those below threshold. `false` return on
    /// the version check means "abort the run, re-fetch the list" — never
    /// bump a stale set (a new entry could be silently skipped).
    pub fn plan_bump(
        &self,
        expected_version: u32,
        remaining: &[(/* entry */ [u8; 32], /* remaining_ledgers */ u32)],
    ) -> Option<Vec<[u8; 32]>> {
        if self.version != expected_version {
            return None;
        }
        Some(
            remaining
                .iter()
                .filter(|(_, r)| should_bump(*r))
                .map(|(e, _)| *e)
                .collect(),
        )
    }
}

/// Cron liveness tracker: counts consecutive bump failures; page when the
/// count exceeds [`CRON_MAX_CONSECUTIVE_FAILURES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CronState {
    pub consecutive_failures: u32,
}

impl CronState {
    pub fn new() -> Self {
        CronState { consecutive_failures: 0 }
    }

    /// Record one run outcome: success resets the counter, failure bumps it
    /// (saturating — the counter is ops telemetry, never auth).
    pub fn record_result(&mut self, ok: bool) {
        if ok {
            self.consecutive_failures = 0;
        } else {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        }
    }

    /// True once the streak reaches the paging threshold: three consecutive
    /// failures page immediately (spec §4.5 / R1 cron design).
    pub fn needs_page(&self) -> bool {
        self.consecutive_failures >= CRON_MAX_CONSECUTIVE_FAILURES
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Measured typical Soroban fees (CheesecakeLabs, 220 mainnet-shape txs):
    // average minimum resource fee ≈ 215k stroops (0.0215 XLM); ledger-
    // modifying subset ≈ 261k stroops (0.0261 XLM).
    const TYPICAL_NETWORK_FEE: u64 = 215_000;
    const HEAVY_NETWORK_FEE: u64 = 261_000;

    #[test]
    fn percent_binds_on_typical_calls_floor_binds_on_cheap() {
        // 50% of 215k = 107.5k → floor(107500) > 100k floor.
        assert_eq!(protocol_fee(TYPICAL_NETWORK_FEE, 5_000).unwrap(), 107_500);
        assert_eq!(protocol_fee(HEAVY_NETWORK_FEE, 5_000).unwrap(), 130_500);
        // Cheap call: 50% of 50k = 25k < floor → 100k binds.
        assert_eq!(protocol_fee(50_000, 5_000).unwrap(), MIN_PROTOCOL_FEE_STROOPS);
        // Floor ≈ $0.0011 at $0.11/XLM: negligible friction, real minimum.
    }

    #[test]
    fn total_is_additive_and_saturating() {
        assert_eq!(total_fee(215_000, 107_500), 322_500);
        assert_eq!(total_fee(u64::MAX, u64::MAX), u64::MAX);
        assert_eq!(all_in_total(u64::MAX, 1, 1, 1), u64::MAX);
    }

    #[test]
    fn quote_itemizes_rent_and_restore_lines() {
        let q = build_quote(TYPICAL_NETWORK_FEE, 0, 0, 1, 9_999_000).unwrap();
        assert_eq!(q.protocol_fee, 107_500);
        assert_eq!(q.total_quoted, 322_500);
        // Restore preview non-empty → restore_fee line present, in totals (AC4.3).
        let r = build_quote(TYPICAL_NETWORK_FEE, 40_000, 25_000, 1, 9_999_000).unwrap();
        assert_eq!(r.total_quoted, 215_000 + 40_000 + 25_000 + 107_500);
    }

    #[test]
    fn drift_gate_is_all_in_with_boundary_vectors() {
        // Spec AC4.2: quoted 100k / attested 120k all-in passes; 120_001 fails.
        assert!(within_drift(100_000, 120_000));
        assert!(!within_drift(100_000, 120_001));
        assert!(within_drift(100_000, 50_000)); // under-quote is fine
    }

    #[test]
    fn sponsored_happy_path_and_each_fail_closed() {
        let balance = 10_000_000; // 1 XLM
        let q = build_quote(215_000, 0, 0, 1, 9_999_000).unwrap();
        let (p, t) = check_sponsored(&q, 215_000, 0, 0, 1, 1_000_000, balance).unwrap();
        assert_eq!((p, t), (107_500, 322_500));
        // Typical-call spec vector AC3.1.
        assert_eq!((p, t), (107_500, 322_500));
        // 120%-drift re-quote trigger: attested 260k vs quoted 215k.
        assert_eq!(
            check_sponsored(&q, 260_000, 0, 0, 1, 1_000_000, balance),
            Err(FeeError::DriftExceeded)
        );
        // R6 case: rent spike 10× between quote and submit is caught even
        // when the network fee itself is unchanged.
        assert_eq!(
            check_sponsored(&q, 215_000, 400_000, 0, 1, 1_000_000, balance),
            Err(FeeError::DriftExceeded)
        );
        // Sponsor-downgrade / unknown policy rejected.
        assert_eq!(
            check_sponsored(&q, 215_000, 0, 0, 99, 1_000_000, balance),
            Err(FeeError::UnknownFeePolicy)
        );
        // User max-total cap (G2/D2) enforced — before the balance check.
        assert_eq!(
            check_sponsored(&q, 215_000, 0, 0, 1, 300_000, balance),
            Err(FeeError::ExceedsUserMax)
        );
        // Balance bound.
        assert_eq!(
            check_sponsored(&q, 215_000, 0, 0, 1, 1_000_000, 100),
            Err(FeeError::InsufficientFunds)
        );
    }

    #[test]
    fn over_max_bps_rejected() {
        assert_eq!(protocol_fee(215_000, 5_001), Err(FeeError::ExceedsMaxBps));
    }

    #[test]
    fn reconciliation_flags_spike_beyond_drift() {
        assert!(reconcile_fee_charged(215_000, 215_000));
        assert!(reconcile_fee_charged(215_000, 200_000)); // under-charge ok
        assert!(!reconcile_fee_charged(215_000, 260_000)); // spike → alert
    }

    #[test]
    fn ttl_maps_to_ledgers_with_600s_max() {
        assert_eq!(ttl_secs_to_ledgers(600), 120);
        assert_eq!(ttl_secs_to_ledgers(601), 121);
        assert!(MAX_TTL_SECS == 600);
    }

    /// TTL-cron skeleton (ANT-703): bump threshold, version-pinned bump set,
    /// 3-strike paging.
    #[test]
    fn cron_bump_threshold_and_version_pin() {
        assert!(should_bump(16_999));
        assert!(!should_bump(17_000)); // boundary: bump only when BELOW ~17k
        assert!(!should_bump(u32::MAX));
        let set = BumpSet { version: 7, entries: vec![[0x01; 32], [0x02; 32]] };
        let remaining = [([0x01; 32], 5_000u32), ([0x02; 32], 100_000u32)];
        // Fresh version: only the low-TTL entry is bumped.
        assert_eq!(set.plan_bump(7, &remaining), Some(vec![[0x01; 32]]));
        // Stale version: abort the run (fail-closed — re-fetch, never bump blind).
        assert_eq!(set.plan_bump(6, &remaining), None);
        assert_eq!(set.plan_bump(8, &remaining), None);
    }

    #[test]
    fn cron_pages_on_three_consecutive_failures() {
        let mut s = CronState::new();
        assert!(!s.needs_page());
        s.record_result(false);
        s.record_result(false);
        assert!(!s.needs_page()); // two in a row: no page yet
        s.record_result(false);
        assert!(s.needs_page()); // third consecutive failure pages
        s.record_result(true); // success resets the streak
        assert!(!s.needs_page());
        assert_eq!(s.consecutive_failures, 0);
    }
}
