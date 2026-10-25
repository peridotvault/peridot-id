//! V3 fee policy: attested network fee + fixed protocol percentage.
//!
//! The user authorizes the transaction intent plus a `feePolicyVersion` — never
//! amounts. The relayer attests `network_fee` (realtime network cost); the program
//! recomputes `protocol_fee` from the immutable policy table and enforces the split:
//! relayerFee (`= network_fee`) → fee payer, protocolFee → canonical revenue vault.
//! Rates live here — never at call sites, never in per-call fields.
//! See `contracts/WHITEPAPER.md` §2.

use crate::errors::PeridotError;
use pinocchio::error::ProgramError;

/// Only supported fee-policy version (v1, frozen).
pub const FEE_POLICY_V1: u16 = 1;
/// Policy v1 protocol fee: 50% of the attested network fee (5000 bps).
pub const PROTOCOL_FEE_BPS_V1: u16 = 5000;
/// Fee-policy v2 (ANT-544 FR-B, ANT-556): percentage leg unchanged (5000 bps)
/// plus the per-chain native-unit floor (`CHAIN_MIN_LAMPORTS_V2`).
/// Rows are immutable once published; new minima ship as a new version.
pub const FEE_POLICY_V2: u16 = 2;
/// Policy v2 protocol fee: 50% of the attested network fee (5000 bps).
pub const PROTOCOL_FEE_BPS_V2: u16 = 5000;
/// Policy v2 chain floor: 0.000017 SOL = 17_000 lamports (ANT-544 B2).
pub const CHAIN_MIN_LAMPORTS_V2: u64 = 17_000;
/// Protocol-enforced maximum percentage any policy may carry.
pub const MAX_PROTOCOL_FEE_BPS: u16 = 5000;

/// Protocol-fee bps for a signed policy version, enforcing the protocol maximum.
/// Frozen v1 behavior: version 1 → 5000 bps, anything else → UnknownFeePolicy.
pub fn policy_protocol_bps(version: u16) -> Result<u16, ProgramError> {
    let bps = match version {
        FEE_POLICY_V1 => PROTOCOL_FEE_BPS_V1,
        _ => return Err(PeridotError::UnknownFeePolicy.into()),
    };
    if bps > MAX_PROTOCOL_FEE_BPS {
        return Err(PeridotError::ExceedsMaxBps.into());
    }
    Ok(bps)
}

/// Fee-policy v2 row: `(bps, chain_min_lamports)` for a signed policy version.
/// v1 keeps its frozen row `(5000, 0)`; v2 adds the 17_000-lamport floor.
/// Unknown versions fail closed (safe before signature verification).
pub fn policy_v2_row(version: u16) -> Result<(u16, u64), ProgramError> {
    match version {
        FEE_POLICY_V1 => Ok((PROTOCOL_FEE_BPS_V1, 0)),
        FEE_POLICY_V2 => {
            if PROTOCOL_FEE_BPS_V2 > MAX_PROTOCOL_FEE_BPS {
                return Err(PeridotError::ExceedsMaxBps.into());
            }
            Ok((PROTOCOL_FEE_BPS_V2, CHAIN_MIN_LAMPORTS_V2))
        }
        _ => Err(PeridotError::UnknownFeePolicy.into()),
    }
}

/// Split an attested network fee into `(relayer_fee, protocol_fee)` where
/// `relayer_fee = network_fee` (exact reimbursement) and
/// `protocol_fee = floor(network_fee × bps / 10_000)` (floor favors the user).
/// Frozen v1 formula.
pub fn split_attested_fee(network_fee: u64, bps: u16) -> (u64, u64) {
    let protocol_fee =
        ((network_fee as u128 * bps as u128) / 10_000u128) as u64;
    (network_fee, protocol_fee)
}

/// Split an attested network fee under fee-policy v2 (ANT-544 B1):
/// `protocol_fee = MAX(floor(network_fee × bps / 10_000), chain_min)`.
/// Floor division favors the user; the floor leg guarantees protocol revenue
/// on tiny-fee transactions. u128 intermediates, no floats.
pub fn split_attested_fee_v2(network_fee: u64, bps: u16, chain_min: u64) -> (u64, u64) {
    let pct = ((network_fee as u128 * bps as u128) / 10_000u128) as u64;
    let protocol_fee = pct.max(chain_min);
    (network_fee, protocol_fee)
}

/// Total debit for a spend: `network_fee + protocol_fee`, saturating at u64::MAX
/// (callers treat saturation as unaffordable via the balance check).
pub fn total_fee(network_fee: u64, protocol_fee: u64) -> u64 {
    network_fee.saturating_add(protocol_fee)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_attested_50_percent_policy() {
        // network 10000 at 5000 bps → relayer 10000, protocol 5000.
        let (relayer_fee, protocol_fee) = split_attested_fee(10_000, 5000);
        assert_eq!((relayer_fee, protocol_fee), (10_000, 5_000));
    }

    #[test]
    fn split_attested_zero_is_zero() {
        assert_eq!(split_attested_fee(0, 5000), (0, 0));
    }

    #[test]
    fn split_attested_floors_protocol_fee() {
        // 1 lamport at 50% → protocol 0, relayer made whole exactly.
        assert_eq!(split_attested_fee(1, 5000), (1, 0));
        // No dust loss: relayer + protocol always reconstructible from inputs.
        for fee in [0u64, 1, 2, 3, 7, 999, 1_000_000, u64::MAX / 2] {
            let (r, p) = split_attested_fee(fee, 5000);
            assert_eq!(r, fee);
            assert!(p <= fee / 2 + 1);
        }
    }

    #[test]
    fn unknown_policy_rejected() {
        assert!(policy_protocol_bps(1).is_ok());
        assert!(policy_protocol_bps(2).is_err());
        assert!(policy_protocol_bps(0).is_err());
    }

    #[test]
    fn policy_v2_row_pins_bps_and_floor() {
        // v1 row frozen: (5000, 0).
        assert_eq!(policy_v2_row(1).unwrap(), (5000, 0));
        // v2 row: (5000, 17_000).
        assert_eq!(policy_v2_row(2).unwrap(), (5000, CHAIN_MIN_LAMPORTS_V2));
        assert_eq!(CHAIN_MIN_LAMPORTS_V2, 17_000);
        // Unknown versions fail closed.
        assert!(policy_v2_row(0).is_err());
        assert!(policy_v2_row(3).is_err());
    }

    #[test]
    fn split_attested_fee_v2_max_logic() {
        // ANT-544 B3 Solana vector: network 5000 → floor wins (17_000) → total 22_000.
        let (r, p) = split_attested_fee_v2(5_000, 5000, CHAIN_MIN_LAMPORTS_V2);
        assert_eq!((r, p), (5_000, 17_000));
        assert_eq!(total_fee(r, p), 22_000);
        // Percentage leg wins above the floor: network 100_000 → 50_000.
        assert_eq!(split_attested_fee_v2(100_000, 5000, CHAIN_MIN_LAMPORTS_V2), (100_000, 50_000));
        // Exact boundary: 34_000 → 17_000 == floor (either leg, same value).
        assert_eq!(split_attested_fee_v2(34_000, 5000, CHAIN_MIN_LAMPORTS_V2), (34_000, 17_000));
        // Zero network fee still charges the floor (never free protocol revenue).
        assert_eq!(split_attested_fee_v2(0, 5000, CHAIN_MIN_LAMPORTS_V2), (0, 17_000));
        // v1 row (chain_min 0) reproduces the frozen formula exactly.
        for fee in [0u64, 1, 7, 999, 1_000_000, u64::MAX / 2] {
            assert_eq!(split_attested_fee_v2(fee, 5000, 0), split_attested_fee(fee, 5000));
        }
    }

    #[test]
    fn total_fee_additive() {
        assert_eq!(total_fee(10_000, 5_000), 15_000);
        assert_eq!(total_fee(u64::MAX, 1), u64::MAX); // saturates, never wraps
    }
}
