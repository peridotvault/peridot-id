//! Experiment 1 (part 1): passkey-signed digest binding + RP-ID/UV checks.
//!
//! Payload layout (pending Theo spec acceptance, §9.1):
//! `PID|STELLAR|SMART_ACCOUNT|v1` domain, then the op tag, account, nonce,
//! scope hash, expiry ledger, fee policy version, user max-total fee, and the
//! context-rule IDs. EVERY policy field is inside the signed digest — this is
//! the mitigation for the OZ sponsor-mutable-rule finding (Tobias review,
//! §9.2): a relayer that re-selects a weaker rule post-signature changes the
//! digest, so the passkey signature no longer verifies.
//!
//! OZ v0.8.0 lineage binds `sha256(AuthDigestPreimage { account,
//! signature_payload, context_rule_ids })`; our Peridot policy fields live
//! inside `signature_payload`, which this module lays out explicitly.

use sha2::{Digest, Sha256};

/// Domain separator for the Stellar smart-account payload.
pub const DOMAIN_STELLAR_SMART_ACCOUNT_V1: &[u8] = b"PID|STELLAR|SMART_ACCOUNT|v1";

/// Op tags (mirror the V3 `0x00/0x01/0x03` family on a fresh chain tag space).
pub const OP_INIT: u8 = 0x10;
pub const OP_EXECUTE: u8 = 0x11;
pub const OP_ROTATE: u8 = 0x13;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    BadRpId,
    UserVerificationMissing,
    BadChallenge,
    DigestMismatch,
}

/// All policy fields bound in the signed digest (Tobias gate §9.2).
#[derive(Debug, Clone)]
pub struct StellarIntent {
    pub op_tag: u8,
    /// Contract address bytes of the smart account (StrKey-decoded, 32B).
    pub account: [u8; 32],
    /// Per-session sequence / nonce (replay protection, contract state).
    pub nonce: u64,
    /// Scope hash: sha256 over the granted scope descriptor.
    pub scope_hash: [u8; 32],
    /// Expiry as ledger sequence (≤600s TTL ≈ now+120 ledgers).
    pub expiry_ledger: u32,
    pub fee_policy_version: u16,
    /// User-authorized max total fee in stroops (G2/D2).
    pub max_total_fee: u64,
    /// Context-rule IDs selected for this intent (sponsor MUST NOT mutate).
    pub rule_ids: Vec<[u8; 32]>,
}

/// Canonical preimage: DOMAIN ‖ op ‖ account ‖ nonce(le) ‖ scope_hash ‖
/// expiry_ledger(le) ‖ fee_policy_version(le) ‖ max_total_fee(le) ‖
/// rule_count(le) ‖ rule_ids… Digest = sha256(preimage).
pub fn digest_for_intent(intent: &StellarIntent) -> [u8; 32] {
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
    digest
}

/// WebAuthn assertion check: RP-ID hash matches, UV flag set, and the signed
/// challenge equals the intent digest.
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

    fn intent(rule_suffix: u8, max_total_fee: u64) -> StellarIntent {
        StellarIntent {
            op_tag: OP_EXECUTE,
            account: [0xABu8; 32],
            nonce: 7,
            scope_hash: [0x11u8; 32],
            expiry_ledger: 9_999_100,
            fee_policy_version: 1,
            max_total_fee,
            rule_ids: vec![[rule_suffix; 32]],
        }
    }

    /// Sponsor-downgrade regression test (Tobias gate §9.2): changing ANY
    /// bound policy field — rule ID, max fee, scope, expiry, nonce — changes
    /// the digest, so a relayer-mutated intent fails passkey verification.
    #[test]
    fn every_policy_field_is_digest_bound() {
        let base = digest_for_intent(&intent(0x01, 1_000_000));
        // Rule re-selection (the OZ audit finding) changes the digest.
        assert_ne!(base, digest_for_intent(&intent(0x02, 1_000_000)));
        // Max-total downgrade/upgrade changes the digest.
        assert_ne!(base, digest_for_intent(&intent(0x01, 2_000_000)));
        // Nonce, expiry, scope, op, account, fee version all bound.
        let mut m = intent(0x01, 1_000_000);
        m.nonce = 8;
        assert_ne!(base, digest_for_intent(&m));
        let mut m = intent(0x01, 1_000_000);
        m.expiry_ledger += 1;
        assert_ne!(base, digest_for_intent(&m));
        let mut m = intent(0x01, 1_000_000);
        m.scope_hash = [0x22u8; 32];
        assert_ne!(base, digest_for_intent(&m));
        let mut m = intent(0x01, 1_000_000);
        m.op_tag = OP_ROTATE;
        assert_ne!(base, digest_for_intent(&m));
        let mut m = intent(0x01, 1_000_000);
        m.account = [0xCDu8; 32];
        assert_ne!(base, digest_for_intent(&m));
        let mut m = intent(0x01, 1_000_000);
        m.fee_policy_version = 2;
        assert_ne!(base, digest_for_intent(&m));
        // Deterministic: same intent, same digest.
        assert_eq!(base, digest_for_intent(&intent(0x01, 1_000_000)));
    }

    #[test]
    fn webauthn_checks_rp_id_uv_and_challenge() {
        let base = intent(0x01, 1_000_000);
        let digest = digest_for_intent(&base);
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
        let other = digest_for_intent(&intent(0x02, 1_000_000));
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
