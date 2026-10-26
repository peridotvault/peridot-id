//! Stellar smart-account intent digest, Phase-1 P1 (ANT-703).
//!
//! Hard cutover from the Phase-0 v1 layout (testnet-only; Phase-0 vectors
//! are throwaway — no v1 migration, no dual-version support):
//!
//! - **F1 — DOMAIN v2 with network binding** (Tobias finding F1): the v1
//!   preimage had no network/passphrase binding, so a passkey signature was
//!   replayable across Stellar networks at the inner-auth layer (same
//!   deployer + same salt ⇒ same contract ID on testnet and mainnet).
//!   The v2 preimage binds `network_id` (SHA-256 of the network passphrase).
//!   In production the contract recomputes it from
//!   `env.ledger().network_id()` (host truth, never caller-supplied); this
//!   pure crate takes it as a parameter. The SDK reads the expected id from
//!   RPC `getNetwork` and refuses to sign on mismatch (client pre-check);
//!   the contract rejects with [`AuthError::BadNetwork`] (enforcement).
//! - **G2 — snapshot-bound u32 rule IDs** (Tobias finding G2): the intent no
//!   longer carries `[u8;32]` rule hashes (which nothing linked to OZ's
//!   auto-increment `u32` context-rule IDs). It carries
//!   `(snapshot_version, oz_rule_ids)`; the sponsor cannot remap because the
//!   u32s are signature-bound and the contract resolves them against the
//!   stored snapshot, failing closed on version mismatch
//!   ([`AuthError::StaleSnapshot`]).
//!
//! Preimage v2: `DOMAIN_V2 ‖ op ‖ account ‖ nonce(le) ‖ scope_hash ‖`
//! `expiry_ledger(le) ‖ fee_policy_version(le) ‖ max_total_fee(le) ‖`
//! `network_id ‖ snapshot_version(le) ‖ rule_count(le) ‖ oz_rule_ids…(le)`.
//! Digest = sha256(preimage). With 8 rules the preimage is 187 bytes
//! (vs 375 max under v1).
//!
//! Domain lenses: reentrancy N/A (pure digest math, no external calls);
//! checks-effects-interactions preserved by keeping every policy field
//! inside the signed digest; access control on snapshot writes is a
//! contract concern (self-auth-gated registration), not modeled here.

use sha2::{Digest, Sha256};

/// Domain separator, Phase-1 v2. Exactly 28 bytes (spec §1.2 erratum:
/// "25 bytes" is wrong — measured `len()`).
pub const DOMAIN_STELLAR_SMART_ACCOUNT_V2: &[u8] = b"PID|STELLAR|SMART_ACCOUNT|v2";

/// Op tags (Theo R3): `0x10/0x11/0x13` confirmed; `0x12` RESERVED
/// (future delegate-class op, Phase-1+ only, never emitted);
/// `0x00–0x0F` never reused (V3 EVM family collision avoidance).
pub const OP_INIT: u8 = 0x10;
pub const OP_EXECUTE: u8 = 0x11;
pub const OP_DELEGATE_RESERVED: u8 = 0x12;
pub const OP_ROTATE: u8 = 0x13;

/// Max OZ rule IDs per intent (Theo R1 bound retained through the G2
/// migration: 8 × u32 keeps the preimage at 187 bytes).
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
    /// F1: caller-supplied network id ≠ host `env.ledger().network_id()`.
    BadNetwork,
    /// G2: intent `snapshot_version` ≠ stored snapshot version (fail-closed
    /// both directions — stale AND future versions are rejected; the client
    /// re-fetches and re-signs).
    StaleSnapshot,
}

/// All policy fields bound in the signed digest (Tobias gate §9.2, as
/// migrated by F1/G2).
#[derive(Debug, Clone)]
pub struct StellarIntent {
    pub op_tag: u8,
    /// Contract address bytes of the smart account (StrKey-decoded, 32B).
    pub account: [u8; 32],
    /// Per-account strictly-increasing sequence (Theo R2).
    pub nonce: u64,
    /// Scope hash: sha256 over the canonical scope descriptor
    /// (`rules::scope_hash` — T3).
    pub scope_hash: [u8; 32],
    /// Expiry as ledger sequence (≤ current + 120).
    pub expiry_ledger: u32,
    pub fee_policy_version: u16,
    /// User-authorized cap in stroops (G2/D2).
    pub max_total_fee: u64,
    /// F1: SHA-256 of the network passphrase. Production value comes from
    /// `env.ledger().network_id()` (host truth); the SDK pre-checks it via
    /// RPC `getNetwork` before signing.
    pub network_id: [u8; 32],
    /// G2: snapshot version pinning the `oz_rule_ids` below.
    pub snapshot_version: u32,
    /// G2: OZ context-rule IDs selected for this intent (sponsor MUST NOT
    /// mutate — they are digest-bound and resolved against the snapshot).
    pub oz_rule_ids: Vec<u32>,
}

/// G2 snapshot entry: the registration-time pin between our 32B rule hash
/// and the OZ auto-increment `u32` id. Append-only-marked: entries are
/// never deleted-then-reused (safe because OZ ids are never reused —
/// `NextId` only increments).
#[derive(Debug, Clone)]
pub struct RuleSnapshotEntry {
    pub rule_hash: [u8; 32],
    pub oz_id: u32,
    /// OZ-side `valid_until` (ledger seq), if set at registration.
    pub valid_until: Option<u32>,
}

/// G2 on-chain snapshot: `(rule_hash → oz_id, valid_until)` rows plus a
/// monotonic version. The SDK keeps a mirror for signing; the contract copy
/// is authoritative (caller cannot forge the mapping).
#[derive(Debug, Clone)]
pub struct RuleSnapshot {
    pub version: u32,
    pub entries: Vec<RuleSnapshotEntry>,
}

impl RuleSnapshot {
    /// Resolve an OZ id to its pinned entry (unknown id ⇒ `None` ⇒
    /// fail-closed at the call site: OZ raises `ContextRuleNotFound` /
    /// `UnvalidatedContext` on-chain regardless).
    pub fn resolve(&self, oz_id: u32) -> Option<&RuleSnapshotEntry> {
        self.entries.iter().find(|e| e.oz_id == oz_id)
    }

    /// Fail-closed version pin: the intent version must equal the stored
    /// version exactly. `min(OZ valid_until, intent expiry_ledger)` needs no
    /// extra mechanism beyond this plus both checks existing (OZ enforces
    /// `valid_until` on-chain; [`check_expiry`] enforces the intent side).
    pub fn check_version(&self, intent_version: u32) -> Result<(), AuthError> {
        if intent_version == self.version {
            Ok(())
        } else {
            Err(AuthError::StaleSnapshot)
        }
    }
}

/// A snapshot entry is live while its OZ `valid_until` (if any) has not
/// passed. Unset `valid_until` means no OZ-side expiry (the intent
/// `expiry_ledger` still bounds the session).
pub fn snapshot_entry_live(entry: &RuleSnapshotEntry, current_ledger: u32) -> bool {
    match entry.valid_until {
        Some(until) => current_ledger <= until,
        None => true,
    }
}

/// F1 enforcement hook: the host-provided network id must equal the id the
/// signer committed to. In production `host_id` is
/// `env.ledger().network_id()`; a mismatch means cross-network replay.
pub fn check_network(host_id: &[u8; 32], intent_network_id: &[u8; 32]) -> Result<(), AuthError> {
    if host_id == intent_network_id {
        Ok(())
    } else {
        Err(AuthError::BadNetwork)
    }
}

/// Canonical v2 preimage: DOMAIN_V2 ‖ op ‖ account ‖ nonce(le) ‖
/// scope_hash ‖ expiry_ledger(le) ‖ fee_policy_version(le) ‖
/// max_total_fee(le) ‖ network_id ‖ snapshot_version(le) ‖ rule_count(le) ‖
/// oz_rule_ids…(u32le each). Digest = sha256(preimage).
/// Rejects `oz_rule_ids.len() > MAX_RULE_IDS` (Theo R1) before hashing.
pub fn digest_for_intent_v2(intent: &StellarIntent) -> Result<[u8; 32], AuthError> {
    if intent.oz_rule_ids.len() > MAX_RULE_IDS {
        return Err(AuthError::TooManyRules);
    }
    let mut buf = Vec::with_capacity(
        DOMAIN_STELLAR_SMART_ACCOUNT_V2.len() + 1 + 32 + 8 + 32 + 4 + 2 + 8 + 32 + 4 + 4
            + 4 * intent.oz_rule_ids.len(),
    );
    buf.extend_from_slice(DOMAIN_STELLAR_SMART_ACCOUNT_V2);
    buf.push(intent.op_tag);
    buf.extend_from_slice(&intent.account);
    buf.extend_from_slice(&intent.nonce.to_le_bytes());
    buf.extend_from_slice(&intent.scope_hash);
    buf.extend_from_slice(&intent.expiry_ledger.to_le_bytes());
    buf.extend_from_slice(&intent.fee_policy_version.to_le_bytes());
    buf.extend_from_slice(&intent.max_total_fee.to_le_bytes());
    buf.extend_from_slice(&intent.network_id);
    buf.extend_from_slice(&intent.snapshot_version.to_le_bytes());
    buf.extend_from_slice(&(intent.oz_rule_ids.len() as u32).to_le_bytes());
    for id in &intent.oz_rule_ids {
        buf.extend_from_slice(&id.to_le_bytes());
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

    /// Testnet passphrase → network id (host truth on testnet).
    fn testnet_id() -> [u8; 32] {
        Sha256::digest(b"Test SDF Network ; September 2015").into()
    }

    /// Mainnet passphrase → network id (host truth on mainnet).
    fn mainnet_id() -> [u8; 32] {
        Sha256::digest(b"Public Global Stellar Network ; September 2015").into()
    }

    fn intent(oz_rule_ids: Vec<u32>, max_total_fee: u64) -> StellarIntent {
        StellarIntent {
            op_tag: OP_EXECUTE,
            account: [0xABu8; 32],
            nonce: 7,
            scope_hash: [0x11u8; 32],
            expiry_ledger: 9_999_100,
            fee_policy_version: 1,
            max_total_fee,
            network_id: testnet_id(),
            snapshot_version: 3,
            oz_rule_ids,
        }
    }

    /// F1 erratum: DOMAIN_V2 is exactly 28 bytes.
    #[test]
    fn domain_v2_is_28_bytes() {
        assert_eq!(DOMAIN_STELLAR_SMART_ACCOUNT_V2.len(), 28);
        assert_eq!(DOMAIN_STELLAR_SMART_ACCOUNT_V2, b"PID|STELLAR|SMART_ACCOUNT|v2");
    }

    /// F1 core: the identical intent under the testnet id vs the mainnet id
    /// digests differently — a testnet passkey signature does NOT verify at
    /// the inner-auth layer on mainnet (and vice versa).
    #[test]
    fn cross_network_digests_differ() {
        let testnet = digest_for_intent_v2(&intent(vec![1], 1_000_000)).unwrap();
        let mut mainnet_intent = intent(vec![1], 1_000_000);
        mainnet_intent.network_id = mainnet_id();
        let mainnet = digest_for_intent_v2(&mainnet_intent).unwrap();
        assert_ne!(testnet, mainnet);
        // Sanity: the two network ids themselves differ.
        assert_ne!(testnet_id(), mainnet_id());
    }

    /// F1 enforcement: host id ≠ committed id ⇒ `BadNetwork`; equality ⇒ ok.
    /// In production the host id is `env.ledger().network_id()`.
    #[test]
    fn network_mismatch_rejected() {
        let i = intent(vec![1], 1_000_000);
        assert!(check_network(&testnet_id(), &i.network_id).is_ok());
        assert_eq!(
            check_network(&mainnet_id(), &i.network_id),
            Err(AuthError::BadNetwork)
        );
    }

    /// F1 host-id recomputation: rebuild the v2 preimage by hand (field
    /// order per the module doc) and assert byte-equality with
    /// `digest_for_intent_v2` — the same assertion the testnet deploy must
    /// make against the on-chain `signature_payload` (Tobias G1).
    #[test]
    fn host_id_recomputation_matches_digest() {
        let i = intent(vec![1, 2], 1_000_000);
        let mut preimage = Vec::new();
        preimage.extend_from_slice(b"PID|STELLAR|SMART_ACCOUNT|v2");
        preimage.push(OP_EXECUTE);
        preimage.extend_from_slice(&[0xABu8; 32]);
        preimage.extend_from_slice(&7u64.to_le_bytes());
        preimage.extend_from_slice(&[0x11u8; 32]);
        preimage.extend_from_slice(&9_999_100u32.to_le_bytes());
        preimage.extend_from_slice(&1u16.to_le_bytes());
        preimage.extend_from_slice(&1_000_000u64.to_le_bytes());
        preimage.extend_from_slice(&testnet_id());
        preimage.extend_from_slice(&3u32.to_le_bytes());
        preimage.extend_from_slice(&2u32.to_le_bytes());
        preimage.extend_from_slice(&1u32.to_le_bytes());
        preimage.extend_from_slice(&2u32.to_le_bytes());
        // v2+G2 size check: 28+1+32+8+32+4+2+8+32+4+4+8 = 163 bytes here.
        assert_eq!(preimage.len(), 163);
        let expect: [u8; 32] = Sha256::digest(&preimage).into();
        assert_eq!(digest_for_intent_v2(&i).unwrap(), expect);
    }

    /// Hard-cutover proof (no v1 migration, no dual-version): the v1
    /// preimage for the "same" intent (DOMAIN v1, no network id, 32B rule
    /// hash section) digests DIFFERENTLY from v2 — Phase-0 vectors cannot
    /// verify under v2 and are therefore throwaway.
    #[test]
    fn v1_preimage_rejected_by_construction() {
        // Reconstruct the Phase-0 v1 preimage bytes for an equivalent intent.
        let mut v1 = Vec::new();
        v1.extend_from_slice(b"PID|STELLAR|SMART_ACCOUNT|v1");
        v1.push(OP_EXECUTE);
        v1.extend_from_slice(&[0xABu8; 32]);
        v1.extend_from_slice(&7u64.to_le_bytes());
        v1.extend_from_slice(&[0x11u8; 32]);
        v1.extend_from_slice(&9_999_100u32.to_le_bytes());
        v1.extend_from_slice(&1u16.to_le_bytes());
        v1.extend_from_slice(&1_000_000u64.to_le_bytes());
        v1.extend_from_slice(&1u32.to_le_bytes());
        v1.extend_from_slice(&[0x01u8; 32]);
        let v1_digest: [u8; 32] = Sha256::digest(&v1).into();
        let v2_digest = digest_for_intent_v2(&intent(vec![1], 1_000_000)).unwrap();
        assert_ne!(v1_digest, v2_digest);
    }

    /// Sponsor-downgrade regression test (Tobias gate §9.2, migrated to v2):
    /// changing ANY bound policy field — rule ID, snapshot version, network,
    /// max fee, scope, expiry, nonce — changes the digest, so a
    /// relayer-mutated intent fails passkey verification.
    #[test]
    fn every_policy_field_is_digest_bound() {
        let base = digest_for_intent_v2(&intent(vec![1], 1_000_000)).unwrap();
        // OZ rule-ID re-selection (the G2 equivocation case) changes the digest.
        assert_ne!(base, digest_for_intent_v2(&intent(vec![2], 1_000_000)).unwrap());
        // Swapped u32 order changes the digest (equivocation ⇒ mismatch).
        assert_ne!(
            base,
            digest_for_intent_v2(&intent(vec![1, 2], 1_000_000)).unwrap()
        );
        // Snapshot-version downgrade changes the digest.
        let mut m = intent(vec![1], 1_000_000);
        m.snapshot_version = 2;
        assert_ne!(base, digest_for_intent_v2(&m).unwrap());
        // Network swap changes the digest.
        let mut m = intent(vec![1], 1_000_000);
        m.network_id = mainnet_id();
        assert_ne!(base, digest_for_intent_v2(&m).unwrap());
        // Max-total downgrade/upgrade changes the digest.
        assert_ne!(base, digest_for_intent_v2(&intent(vec![1], 2_000_000)).unwrap());
        // Nonce, expiry, scope, op, account, fee version all bound.
        let mut m = intent(vec![1], 1_000_000);
        m.nonce = 8;
        assert_ne!(base, digest_for_intent_v2(&m).unwrap());
        let mut m = intent(vec![1], 1_000_000);
        m.expiry_ledger += 1;
        assert_ne!(base, digest_for_intent_v2(&m).unwrap());
        let mut m = intent(vec![1], 1_000_000);
        m.scope_hash = [0x22u8; 32];
        assert_ne!(base, digest_for_intent_v2(&m).unwrap());
        let mut m = intent(vec![1], 1_000_000);
        m.op_tag = OP_ROTATE;
        assert_ne!(base, digest_for_intent_v2(&m).unwrap());
        let mut m = intent(vec![1], 1_000_000);
        m.account = [0xCDu8; 32];
        assert_ne!(base, digest_for_intent_v2(&m).unwrap());
        let mut m = intent(vec![1], 1_000_000);
        m.fee_policy_version = 2;
        assert_ne!(base, digest_for_intent_v2(&m).unwrap());
        // Deterministic: same intent, same digest.
        assert_eq!(base, digest_for_intent_v2(&intent(vec![1], 1_000_000)).unwrap());
    }

    /// G2 equivocation closure: `[A,B]` vs `[B,A]` vs `[A]` vs `[]` vs
    /// duplicates all digest differently, and the u32 count prefix keeps
    /// subset/superset distinct.
    #[test]
    fn rule_order_subset_and_duplicates_change_digest() {
        let ab = digest_for_intent_v2(&intent(vec![10, 20], 1_000_000)).unwrap();
        let ba = digest_for_intent_v2(&intent(vec![20, 10], 1_000_000)).unwrap();
        let just_a = digest_for_intent_v2(&intent(vec![10], 1_000_000)).unwrap();
        let empty = digest_for_intent_v2(&intent(vec![], 1_000_000)).unwrap();
        let dup_a = digest_for_intent_v2(&intent(vec![10, 10], 1_000_000)).unwrap();
        assert_ne!(ab, ba);
        assert_ne!(ab, just_a);
        assert_ne!(just_a, empty);
        assert_ne!(ab, dup_a);
        assert_ne!(just_a, dup_a);
    }

    /// Theo R1 (retained through G2): > 8 OZ rule IDs rejected before signing.
    #[test]
    fn too_many_rules_rejected() {
        let nine: Vec<u32> = (0u32..9).collect();
        assert_eq!(
            digest_for_intent_v2(&intent(nine, 1_000_000)),
            Err(AuthError::TooManyRules)
        );
        let eight: Vec<u32> = (0u32..8).collect();
        assert!(digest_for_intent_v2(&intent(eight.clone(), 1_000_000)).is_ok());
        // Size win recorded: 8-rule v2 preimage = 28+1+32+8+32+4+2+8+32+4+4+32 = 187B.
        let full = intent(eight, 1_000_000);
        let preimage_len = 28 + 1 + 32 + 8 + 32 + 4 + 2 + 8 + 32 + 4 + 4 + 4 * full.oz_rule_ids.len();
        assert_eq!(preimage_len, 187);
    }

    /// G2 snapshot: version pin fails closed both directions; unknown OZ ids
    /// resolve to `None` (on-chain fail-closed); removed/expired entries are
    /// observable via `snapshot_entry_live`.
    #[test]
    fn snapshot_version_pin_and_resolution() {
        let snap = RuleSnapshot {
            version: 3,
            entries: vec![
                RuleSnapshotEntry { rule_hash: [0x01; 32], oz_id: 10, valid_until: Some(9_999_500) },
                RuleSnapshotEntry { rule_hash: [0x02; 32], oz_id: 11, valid_until: None },
            ],
        };
        assert!(snap.check_version(3).is_ok());
        assert_eq!(snap.check_version(2), Err(AuthError::StaleSnapshot)); // stale
        assert_eq!(snap.check_version(4), Err(AuthError::StaleSnapshot)); // future
        assert_eq!(snap.resolve(10).unwrap().rule_hash, [0x01; 32]);
        assert!(snap.resolve(99).is_none()); // removed/unknown ⇒ fail closed
        assert!(snapshot_entry_live(&snap.resolve(10).unwrap(), 9_999_000));
        assert!(!snapshot_entry_live(&snap.resolve(10).unwrap(), 9_999_501)); // expired
        assert!(snapshot_entry_live(&snap.resolve(11).unwrap(), u32::MAX)); // no OZ expiry
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
        let base = intent(vec![1], 1_000_000);
        let digest = digest_for_intent_v2(&base).unwrap();
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
        let other = digest_for_intent_v2(&intent(vec![2], 1_000_000)).unwrap();
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
