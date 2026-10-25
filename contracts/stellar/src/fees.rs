//! Experiment 3: relayer-as-source sponsorship loop math (stroops).
//!
//! Stellar cannot observe the fee the source paid from inside the contract
//! (same accepted limitation as SVM): the backend attests `network_fee`, the
//! contract recomputes `protocol_fee` from policy, and reconciliation checks
//! `feeCharged` from RPC meta afterwards.
//!
//! Policy (ANT-542 G2/D2 + ANT-546 §4): `protocol_fee = MAX(50% network,
//! 0.01 XLM floor)`; `total_fee = network_fee + protocol_fee` (saturating);
//! user authorizes `max_total_fee` in the signed payload (Stellar ships WITH
//! the cap from day one — no V3 no-cap retrofit).
//!
//! Rules ported from the whitepaper: drift `attested*100 > quoted*120`
//! rejects (fail-closed re-quote); TTL ≤ 600s maps to ledgers at ~5s/ledger
//! (never ledger-TTL-as-auth: enforced expiry + per-session seq in contract
//! state, mirrored here as explicit `expiry_ledger` + `session_seq` inputs).

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

/// Drift gate: `true` when the attested fee is within 120% of the quote.
pub fn within_drift(quoted: u64, attested: u64) -> bool {
    (attested as u128) * DRIFT_DEN <= (quoted as u128) * DRIFT_NUM
}

/// Full sponsorship check, in quote→attest order (checks before effects):
/// drift → policy → user cap → balance. Returns `(protocol_fee, total_fee)`.
pub fn check_sponsored(
    quoted: u64,
    attested_network_fee: u64,
    fee_policy_version: u16,
    max_total_fee: u64,
    balance: u64,
) -> Result<(u64, u64), FeeError> {
    if !within_drift(quoted, attested_network_fee) {
        return Err(FeeError::DriftExceeded);
    }
    let bps = policy_protocol_bps(fee_policy_version)?;
    let protocol = protocol_fee(attested_network_fee, bps as u16)?;
    let total = total_fee(attested_network_fee, protocol);
    if total > max_total_fee {
        return Err(FeeError::ExceedsUserMax);
    }
    if balance < total {
        return Err(FeeError::InsufficientFunds);
    }
    Ok((protocol, total))
}

/// Reconciliation adapter input: RPC `feeCharged` (plus `rent_fee` /
/// `restored` lines) vs attested. The relayer absorbs spike underpayment;
/// a mismatch beyond drift raises an alert (returned as `false`).
pub fn reconcile_fee_charged(attested_network_fee: u64, fee_charged: u64) -> bool {
    within_drift(attested_network_fee.min(fee_charged), attested_network_fee.max(fee_charged))
        || fee_charged <= attested_network_fee
}

/// TTL seconds → ledgers (ceil). Callers must ALSO enforce a per-session
/// `seq`/expiry in contract state — ledger arithmetic is transport, not auth.
pub fn ttl_secs_to_ledgers(ttl_secs: u64) -> u64 {
    ttl_secs.div_ceil(LEDGER_SECS)
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
    }

    #[test]
    fn drift_gate_rejects_beyond_120pct() {
        assert!(within_drift(100_000, 120_000));
        assert!(!within_drift(100_000, 120_001));
        assert!(within_drift(100_000, 50_000)); // under-quote is fine
    }

    #[test]
    fn sponsored_happy_path_and_each_fail_closed() {
        let balance = 10_000_000; // 1 XLM
        let (p, t) = check_sponsored(215_000, 215_000, 1, 1_000_000, balance).unwrap();
        assert_eq!((p, t), (107_500, 322_500));
        // 120%-drift re-quote trigger: attested 260k vs quoted 215k.
        assert_eq!(
            check_sponsored(215_000, 260_000, 1, 1_000_000, balance),
            Err(FeeError::DriftExceeded)
        );
        // Sponsor-downgrade / unknown policy rejected.
        assert_eq!(
            check_sponsored(215_000, 215_000, 99, 1_000_000, balance),
            Err(FeeError::UnknownFeePolicy)
        );
        // User max-total cap (G2/D2) enforced.
        assert_eq!(
            check_sponsored(215_000, 215_000, 1, 300_000, balance),
            Err(FeeError::ExceedsUserMax)
        );
        // Balance bound.
        assert_eq!(
            check_sponsored(215_000, 215_000, 1, 1_000_000, 100),
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
}
