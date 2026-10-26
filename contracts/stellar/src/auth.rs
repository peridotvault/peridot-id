//! Experiment 1 (part 1): passkey-signed digest binding + RP-ID/UV checks.
//!
//! Payload layout (Theo spec ANT-553, gate §9.1 — ACCEPTED with R1–R6):
//! `PID|STELLAR|SMART_ACCOUNT|v1` domain, then the op tag, account, nonce,
//! scope hash, expiry ledger, fee policy version, user max-total fee, and the
//! context-rule IDs. EVERY policy field is inside the signed digest — the
//! mitigation for the OZ sponsor-mutable-rule finding (Tobias review ANT-554,
//! gate §9.2 — APPROVE WITH CHANGES, changes incorporated here).
//!
//! OZ v0.8.0 lineage binds `sha256(AuthDigestPreimage { account,
//! signature_payload, context_rule_ids })`; our Peridot policy fields live
//! inside `signature_payload`, which this module lays out. Experiment 1 must
//! still assert byte-equality between this digest and the on-chain payload
//! (Tobias G1), plus on-chain nonce consumption (F3).
//!
//! Pre-mainnet items (NOT Phase-0 scope): F1 network/passphrase binding
//! (DOMAIN v2), G2 32B→u32 rule-ID map pinning, `min(OZ valid_until,
//! expiry_ledger)` enforcement.

use sha2::{Digest, Sha256};

/// Domain separator for the Stellar smart-account payload.
pub const DOMAIN_STELLAR_SMART_ACCOUNT_V1: &[u8] = b"PID|STELLAR|SMART_ACCOUNT|v1";

/// Op tags (Theo R3): `0x10/0x11/0x13` confirmed; `0x12` RESERVED
/// (future delegate-class op, Phase-1+ only, never emitted in Phase-0);
/// `0x00–0x0F` never reused (V3 EVM family collision avoidance).
pub const OP_INIT: u8 = 0x10;
pub const OP_EXECUTE: u8 = 0x11;
pub const OP_DELEGATE_RESERVED: u8 = 0x12;
pub const OP_ROTATE: u8 = 0x13;

/// Max rule IDs per intent (Theo R1: preimage ≤ ~340 bytes ledger-arg bound).
pub const MAX_RULE_IDS: usize = 8;
/// Max intent TTL in ledgers (600s @ ~5s/ledger). Ledger arithmetic is
/// transport, never auth — the per-session seq is the replay defense.
pub const MAX_TTL_LEDGERS: u32 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    BadRpId,
    UserVerificationMissing,
    BadChallenge,
    DigestMismatch,
    /// Theo R1: intent carries more than `MAX_RULE_IDS` rule IDs.
    TooManyRules,
    /// Theo R2: `nonce != stored_seq + 1` (checked_add — wrap FORBIDDEN).
    BadNonce,
    /// Expiry in the past or more than `MAX_TTL_LEDGERS` out.
    ExpiredOrTooFar,
}

/// All policy fields bound in the signed digest (Tobias gate §9.2).
#[derive(Debug, Clone)]
pub struct StellarIntent {
    pub op_tag: u8,
    /// Contract address bytes of the smart account (StrKey-decoded, 32B).
    pub account: [u8; 32],
    /// Per-account strictly-increasing sequence (Theo R2).
    pub nonce: u64,
    /// Scope hash: sha256 over the granted scope descriptor.
    pub scope_hash: [u8; 32],
    /// Expiry as ledger sequence (≤ current + 120).
    pub expiry_ledger: u32,
    pub fee_policy_version: u16,
    /// User-authorized cap in stroops (G2/D2).
    pub max_total_fee: u64,
    /// Context-rule IDs selected for this intent (sponsor MUST NOT mutate).
    pub rule_ids: Vec<[u8; 32]>,
}

/// Canonical preimage: DOMAIN ‖ op ‖ account ‖ nonce(le) ‖ scope_hash ‖
/// expiry_ledger(le) ‖ fee_policy_version(le) ‖ max_total_fee(le) ‖
/// rule_count(le) ‖ rule_ids… Digest = sha256(preimage).
/// Rejects `rule_ids.len() > MAX_RULE_IDS` (Theo R1) before hashing.
pub fn digest_for_intent(intent: &StellarIntent) -> Result<[u8; 32], AuthError> {
    if intent.rule_ids.len() > MAX_RULE_IDS {
        return Err(AuthError::TooManyRules);
    }
    let mut buf = Vec::with_capacity(
        DOMAIN_STELLAR_SMART_ACCOUNT_V1.len() + 1 + 32 + 8 + 32 + 4 + 2 + 8 + 4 + 32 * intent.rule_ids.len(),
    );
    buf.extend_from_slice(DOMAIN_STELLAR_SMART_ACCOUNT_V1);
    buf.push(intent.op_tag);
    buf.extend_from_slice(&intent.account);
    buf.extend_from_slice(&intent.nonce.to_le_bytes());
    buf.extend_from_slice(&intent.scope_hash);
    buf.extend_from_slice(&intent.expiry_ledger.to_le_bytes());
    buf.extend_from_slice(&intent.fee_policy_version.to_le_bytes());
    buf.extend_from_slice(&intent.max_total_fee.to_le_bytes());
    buf.extend_from_slice(&(intent.rule_ids.len() as u32).to_le_bytes());
    for id in &intent.rule_ids {
        buf.extend_from_slice(id);
    }
    let out = Sha256::digest(&buf);
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&out);
    Ok(digest)
}

/// Theo R2: replay gate — `nonce` must be exactly `stored_seq + 1`.
/// `checked_add` makes `u64::MAX` wrap acceptance impossible (rotation
/// before wrap is mandatory).
pub fn check_nonce(stored_seq: u64, nonce: u64) -> Result<(), AuthError> {
    match stored_seq.checked_add(1) {
        Some(next) if nonce == next => Ok(()),
        _ => Err(AuthError::BadNonce),
    }
}

/// Freshness bound: `current < expiry <= current + MAX_TTL_LEDGERS`.
pub fn check_expiry(current_ledger: u32, expiry_ledger: u32) -> Result<(), AuthError> {
    if expiry_ledger <= current_ledger {
        return Err(AuthError::ExpiredOrTooFar);
    }
    if expiry_ledger - current_ledger > MAX_TTL_LEDGERS {
        return Err(AuthError::ExpiredOrTooFar);
    }
    Ok(())
}

/// WebAuthn assertion check: RP-ID hash matches (including the embedded
/// `authenticator_data[0..32]` cross-check, Tobias T2), UV flag set, and the
/// signed challenge equals the intent digest.
pub fn verify_webauthn_assertion(
    rp_id: &str,
    rp_id_hash: &[u8; 32],
    authenticator_data: &[u8],
    client_data_challenge: &[u8; 32],
    intent_digest: &[u8; 32],
) -> Result<(), AuthError> {
    let expect = Sha256::digest(rp_id.as_bytes());
    if expect.as_slice() != rp_id_hash {
        return Err(AuthError::BadRpId);
    }
    if authenticator_data.len() < 33 {
        return Err(AuthError::BadChallenge);
    }
    // Tobias T2: the RP ID the authenticator actually signed must equal the
    // claimed rp_id_hash — cheap defense in depth against confused-authenticator input.
    if &authenticator_data[0..32] != rp_id_hash {
        return Err(AuthError::BadRpId);
    }
    // Flags byte is authenticator_data[32]; bit 0x04 = user verified.
    if authenticator_data[32] & 0x04 == 0 {
        return Err(AuthError::UserVerificationMissing);
    }
    if client_data_challenge != intent_digest {
        return Err(AuthError::BadChallenge);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(rule_ids: Vec<[u8; 32]>, max_total_fee: u64) -> StellarIntent {
        StellarIntent {
            op_tag: OP_EXECUTE,
            account: [0xABu8; 32],
            nonce: 7,
            scope_hash: [0x11u8; 32],
            expiry_ledger: 9_999_100,
            fee_policy_version: 1,
            max_total_fee,
            rule_ids,
        }
    }

    /// Sponsor-downgrade regression test (Tobias gate §9.2): changing ANY
    /// bound policy field — rule ID, max fee, scope, expiry, nonce — changes
    /// the digest, so a relayer-mutated intent fails passkey verification.
    #[test]
    fn every_policy_field_is_digest_bound() {
        let base = digest_for_intent(&intent(vec![[0x01; 32]], 1_000_000)).unwrap();
        // Rule re-selection (the OZ audit finding) changes the digest.
        assert_ne!(
            base,
            digest_for_intent(&intent(vec![[0x02; 32]], 1_000_000)).unwrap()
        );
        // Max-total downgrade/upgrade changes the digest.
        assert_ne!(
            base,
            digest_for_intent(&intent(vec![[0x01; 32]], 2_000_000)).unwrap()
        );
        // Nonce, expiry, scope, op, account, fee version all bound.
        let mut m = intent(vec![[0x01; 32]], 1_000_000);
        m.nonce = 8;
        assert_ne!(base, digest_for_intent(&m).unwrap());
        let mut m = intent(vec![[0x01; 32]], 1_000_000);
        m.expiry_ledger += 1;
        assert_ne!(base, digest_for_intent(&m).unwrap());
        let mut m = intent(vec![[0x01; 32]], 1_000_000);
        m.scope_hash = [0x22u8; 32];
        assert_ne!(base, digest_for_intent(&m).unwrap());
        let mut m = intent(vec![[0x01; 32]], 1_000_000);
        m.op_tag = OP_ROTATE;
        assert_ne!(base, digest_for_intent(&m).unwrap());
        let mut m = intent(vec![[0x01; 32]], 1_000_000);
        m.account = [0xCDu8; 32];
        assert_ne!(base, digest_for_intent(&m).unwrap());
        let mut m = intent(vec![[0x01; 32]], 1_000_000);
        m.fee_policy_version = 2;
        assert_ne!(base, digest_for_intent(&m).unwrap());
        // Deterministic: same intent, same digest.
        assert_eq!(
            base,
            digest_for_intent(&intent(vec![[0x01; 32]], 1_000_000)).unwrap()
        );
    }

    /// Tobias T1: multi-rule order/subset sensitivity — `[A,B]` vs `[B,A]`
    /// vs `[A]` vs `[]` vs duplicates all digest differently, and the u32
    /// count prefix keeps subset/superset distinct even where a naive
    /// concatenation could collide.
    #[test]
    fn rule_order_subset_and_duplicates_change_digest() {
        let a = [0xAAu8; 32];
        let b = [0xBBu8; 32];
        let ab = digest_for_intent(&intent(vec![a, b], 1_000_000)).unwrap();
        let ba = digest_for_intent(&intent(vec![b, a], 1_000_000)).unwrap();
        let just_a = digest_for_intent(&intent(vec![a], 1_000_000)).unwrap();
        let empty = digest_for_intent(&intent(vec![], 1_000_000)).unwrap();
        let dup_a = digest_for_intent(&intent(vec![a, a], 1_000_000)).unwrap();
        assert_ne!(ab, ba);
        assert_ne!(ab, just_a);
        assert_ne!(just_a, empty);
        assert_ne!(ab, dup_a);
        assert_ne!(just_a, dup_a);
    }

    /// Theo R1: > 8 rule IDs rejected before signing.
    #[test]
    fn too_many_rules_rejected() {
        let nine: Vec<[u8; 32]> = (0u8..9).map(|i| [i; 32]).collect();
        assert_eq!(
            digest_for_intent(&intent(nine, 1_000_000)),
            Err(AuthError::TooManyRules)
        );
        let eight: Vec<[u8; 32]> = (0u8..8).map(|i| [i; 32]).collect();
        assert!(digest_for_intent(&intent(eight, 1_000_000)).is_ok());
    }

    /// Theo R2: strict `stored + 1`, no wrap.
    #[test]
    fn nonce_gate_is_strict_plus_one() {
        assert!(check_nonce(6, 7).is_ok());
        assert_eq!(check_nonce(6, 6), Err(AuthError::BadNonce)); // replay
        assert_eq!(check_nonce(6, 8), Err(AuthError::BadNonce)); // skip
        assert!(check_nonce(0, 1).is_ok());
        assert_eq!(check_nonce(u64::MAX, 0), Err(AuthError::BadNonce)); // wrap forbidden
    }

    /// Expiry freshness bound (spec §1.4 AC1.5).
    #[test]
    fn expiry_bound_enforced() {
        assert!(check_expiry(1000, 1000 + 120).is_ok());
        assert_eq!(check_expiry(1000, 1000), Err(AuthError::ExpiredOrTooFar));
        assert_eq!(check_expiry(1000, 999), Err(AuthError::ExpiredOrTooFar));
        assert_eq!(check_expiry(1000, 1000 + 121), Err(AuthError::ExpiredOrTooFar));
    }

    #[test]
    fn webauthn_checks_rp_id_uv_and_challenge() {
        let base = intent(vec![[0x01; 32]], 1_000_000);
        let digest = digest_for_intent(&base).unwrap();
        let rp_hash: [u8; 32] = Sha256::digest(b"vault.peridot.example").into();
        // authenticator_data: 32B rpIdHash + flags(UV set) + counter.
        let mut auth_data = vec![0u8; 37];
        auth_data[..32].copy_from_slice(&rp_hash);
        auth_data[32] = 0x04 | 0x01; // UV + UP
        assert!(verify_webauthn_assertion(
            "vault.peridot.example",
            &rp_hash,
            &auth_data,
            &digest,
            &digest
        )
        .is_ok());
        // Wrong RP-ID.
        assert_eq!(
            verify_webauthn_assertion("evil.example", &rp_hash, &auth_data, &digest, &digest),
            Err(AuthError::BadRpId)
        );
        // Tobias T2: embedded rpIdHash mismatches the claimed one.
        let mut tampered = auth_data.clone();
        tampered[0] ^= 0xFF;
        assert_eq!(
            verify_webauthn_assertion(
                "vault.peridot.example",
                &rp_hash,
                &tampered,
                &digest,
                &digest
            ),
            Err(AuthError::BadRpId)
        );
        // UV missing.
        let mut no_uv = auth_data.clone();
        no_uv[32] = 0x01;
        assert_eq!(
            verify_webauthn_assertion(
                "vault.peridot.example",
                &rp_hash,
                &no_uv,
                &digest,
                &digest
            ),
            Err(AuthError::UserVerificationMissing)
        );
        // Challenge (digest) mismatch — e.g. sponsor-mutated intent.
        let other = digest_for_intent(&intent(vec![[0x02; 32]], 1_000_000)).unwrap();
        assert_eq!(
            verify_webauthn_assertion(
                "vault.peridot.example",
                &rp_hash,
                &auth_data,
                &other,
                &digest
            ),
            Err(AuthError::BadChallenge)
        );
    }
}
