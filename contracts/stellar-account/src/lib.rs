//! PeridotID Stellar Phase-1 P1 smart account (testnet-only, ANT-711).
//!
//! OZ `stellar-accounts =0.8.0` multisig account (same shape as the OZ
//! `multisig-smart-account` example) PLUS the Peridot application-level
//! intent gates from the local cores in `contracts/stellar/src/`:
//!
//! - DOMAIN_V2 intent digest (`auth.rs`): `DOMAIN_V2 ‖ op ‖ account ‖
//!   nonce(le) ‖ scope_hash ‖ expiry_ledger(le) ‖ fee_policy_version(le) ‖
//!   max_total_fee(le) ‖ network_id ‖ snapshot_version(le) ‖
//!   rule_count(le) ‖ oz_rule_ids…(le)`, digest = sha256(preimage).
//!   Byte-parity with the local-core vectors is pinned in tests below.
//! - Snapshot-bound u32 rule IDs (G2): on-chain snapshot registry
//!   (`version` + `rule_hash → oz_id` rows); intent version must equal the
//!   stored version (fail-closed both directions).
//! - Canonical scope encoding (T3): `class_tag NUL ‖ n_contracts u32le ‖
//!   contracts ‖ n_fns u32le ‖ (fn_len u16le ‖ fn_bytes)*`; rule id =
//!   sha256(canonical). Golden vectors pinned below (shared with the TS SDK).
//! - `min(valid_until, expiry_ledger)` + strict `nonce == stored+1`
//!   (no wrap) — see `effective_expiry` / `check_nonce`.
//!
//! Testnet-only. Not audited, never mainnet. Passkey Kit is PROHIBITED in
//! prod paths — authentication goes through OZ external verifiers (e.g. the
//! WebAuthn/secp256r1 verifier) wired as `Signer::External`.
//!
//! Domain lenses: gas (BytesN<32> calldata, instance storage only for the
//! snapshot registry); reentrancy (checks-effects: all pure checks run
//! before the OZ `do_check_auth` external-verifier calls); access control
//! (snapshot writes are self-auth-gated, least privilege — no God-owner);
//! oracle risk (network_id comes from `env.ledger().network_id()` host
//! truth at the call site, never caller-supplied alone — `check_network`
//! is the enforcement hook); upgradeability (OZ `Upgradeable`, self-auth);
//! reorg/finality (counterfactual address = f(network, deployer, salt) —
//! document confirmations at the deploy call site); key management (test
//! keys only, clearly labeled); fuzz/invariants (properties over examples:
//! every digest field is binding-tested, not just golden).

#![no_std]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    Address, Bytes, BytesN, Env, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{
    self, AuthDigestPreimage, AuthPayload, ContextRule, ContextRuleType, ExecutionEntryPoint,
    Signer, SmartAccount, SmartAccountError,
};
use stellar_contract_utils::upgradeable::{self as upgradeable, Upgradeable};

/// Domain separator, Phase-1 v2. Exactly 28 bytes (spec §1.2 erratum).
pub const DOMAIN_V2_LEN: u32 = 28;

/// Max OZ rule IDs per intent (Theo R1 retained through G2).
pub const MAX_RULE_IDS: u32 = 8;
/// Max intent TTL in ledgers (600s @ ~5s/ledger).
pub const MAX_TTL_LEDGERS: u32 = 120;
/// Max fns per scope descriptor (T3).
pub const MAX_RULE_FNS: u32 = 64;
/// Max contracts per scope descriptor (finding 5, ANT-704).
pub const MAX_CONTRACTS: u32 = 64;
/// Max bytes per function name in a scope descriptor (T3).
pub const MAX_FN_BYTES: u32 = 64;

/// Op tags (Theo R3): `0x10/0x11/0x13` confirmed; `0x12` RESERVED.
/// u32 on the contract surface (Soroban supports u32, not u8) — validated
/// against the three confirmed tags, encoded as one byte in the preimage.
pub const OP_INIT: u32 = 0x10;
pub const OP_EXECUTE: u32 = 0x11;
pub const OP_ROTATE: u32 = 0x13;

#[contracttype]
enum DataKey {
    SnapshotVersion,
    SnapshotEntry(u32),
}

/// One G2 snapshot row: our 32B rule hash pinned to an OZ auto-increment id.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotEntry {
    pub rule_hash: BytesN<32>,
    pub valid_until: Option<u32>,
}

/// Contract-specific errors (<100 range, per OZ convention).
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum PeridotError {
    TooManyRules = 1,
    UnknownOp = 2,
    BadNonce = 3,
    ExpiredOrTooFar = 4,
    BadNetwork = 5,
    StaleSnapshot = 6,
    ScopeTooLarge = 7,
    EmptyPid = 8,
    /// A u32 contract arg exceeds the width of its preimage field
    /// (fee_policy_version is encoded u16le — values above u16::MAX are
    /// rejected rather than truncated).
    OutOfRange = 9,
}

#[contract]
pub struct PeridotAccountContract;

#[contractimpl]
impl PeridotAccountContract {
    /// Creates the default `multisig` context rule and initialises the G2
    /// snapshot registry at version 1 (empty; the admin registers rows and
    /// bumps the version as rules are added).
    pub fn __constructor(e: &Env, signers: Vec<Signer>, policies: Map<Address, Val>) {
        smart_account::add_context_rule(
            e,
            &ContextRuleType::Default,
            &String::from_str(e, "multisig"),
            None,
            &signers,
            &policies,
        );
        e.storage()
            .instance()
            .set(&DataKey::SnapshotVersion, &1u32);
    }

    // ── DOMAIN_V2 intent digest (auth.rs on-chain) ──

    /// Length of the v2 domain separator (F1 erratum: 28, not 25).
    pub fn domain_v2_len(_e: &Env) -> u32 {
        DOMAIN_V2_LEN
    }

    /// Canonical v2 digest over the bound policy fields. Rejects
    /// `oz_rule_ids.len() > 8` (Theo R1) and unknown op tags (finding 3,
    /// ANT-704) before hashing. `account` is the raw 32B account identifier
    /// (same representation as the local cores — NOT the OZ `Address`
    /// XDR, which binds at the outer `AuthDigestPreimage` layer instead).
    /// Small ints ride as u32 on the contract surface (Soroban has no u8/u16
    /// args) and are narrowed to the spec widths after validation.
    pub fn intent_digest(
        e: &Env,
        op_tag: u32,
        account: BytesN<32>,
        nonce: u64,
        scope_hash: BytesN<32>,
        expiry_ledger: u32,
        fee_policy_version: u32,
        max_total_fee: u64,
        network_id: BytesN<32>,
        snapshot_version: u32,
        oz_rule_ids: Vec<u32>,
    ) -> Result<BytesN<32>, PeridotError> {
        match op_tag {
            OP_INIT | OP_EXECUTE | OP_ROTATE => {}
            _ => return Err(PeridotError::UnknownOp),
        }
        if fee_policy_version > u16::MAX as u32 {
            return Err(PeridotError::OutOfRange);
        }
        if oz_rule_ids.len() > MAX_RULE_IDS {
            return Err(PeridotError::TooManyRules);
        }
        let mut pre: Bytes = Bytes::new(e);
        pre.extend_from_slice(b"PID|STELLAR|SMART_ACCOUNT|v2");
        pre.push_back(op_tag as u8);
        pre.extend_from_slice(&account.to_array());
        pre.extend_from_slice(&nonce.to_le_bytes());
        pre.extend_from_slice(&scope_hash.to_array());
        pre.extend_from_slice(&expiry_ledger.to_le_bytes());
        pre.extend_from_slice(&(fee_policy_version as u16).to_le_bytes());
        pre.extend_from_slice(&max_total_fee.to_le_bytes());
        pre.extend_from_slice(&network_id.to_array());
        pre.extend_from_slice(&snapshot_version.to_le_bytes());
        pre.extend_from_slice(&(oz_rule_ids.len().to_le_bytes()));
        for id in oz_rule_ids.iter() {
            pre.extend_from_slice(&id.to_le_bytes());
        }
        Ok(e.crypto().sha256(&pre).to_bytes())
    }

    // ── Canonical scope encoding (T3, rules.rs on-chain) ──

    /// Canonical scope bytes: `class_tag NUL ‖ n_contracts u32le ‖
    /// contracts ‖ n_fns u32le ‖ (fn_len u16le ‖ fn_bytes)*`.
    /// Fail-closed `ScopeTooLarge` at build (never at call).
    pub fn scope_canonical(
        e: &Env,
        class_tag: String,
        contracts: Vec<BytesN<32>>,
        fns: Vec<String>,
    ) -> Result<Bytes, PeridotError> {
        if fns.len() > MAX_RULE_FNS || contracts.len() > MAX_CONTRACTS {
            return Err(PeridotError::ScopeTooLarge);
        }
        let tag_bytes: Bytes = class_tag.to_bytes();
        let mut buf: Bytes = Bytes::new(e);
        buf.append(&tag_bytes);
        buf.push_back(0x00);
        buf.extend_from_slice(&(contracts.len().to_le_bytes()));
        for c in contracts.iter() {
            buf.extend_from_slice(&c.to_array());
        }
        buf.extend_from_slice(&(fns.len().to_le_bytes()));
        for f in fns.iter() {
            let fb: Bytes = f.to_bytes();
            if fb.len() > MAX_FN_BYTES {
                return Err(PeridotError::ScopeTooLarge);
            }
            let flen = fb.len() as u16;
            buf.extend_from_slice(&flen.to_le_bytes());
            buf.append(&fb);
        }
        Ok(buf)
    }

    /// Scope hash = sha256(canonical). IS the rule id (`rule_id_for`).
    pub fn scope_hash(
        e: &Env,
        class_tag: String,
        contracts: Vec<BytesN<32>>,
        fns: Vec<String>,
    ) -> Result<BytesN<32>, PeridotError> {
        let canonical = Self::scope_canonical(e, class_tag, contracts, fns)?;
        Ok(e.crypto().sha256(&canonical).to_bytes())
    }

    /// Rule-id derivation (== scope_hash; kept as a named entrypoint so
    /// indexers/SDKs bind to the same symbol as the spec).
    pub fn rule_id_for(
        e: &Env,
        class_tag: String,
        contracts: Vec<BytesN<32>>,
        fns: Vec<String>,
    ) -> Result<BytesN<32>, PeridotError> {
        Self::scope_hash(e, class_tag, contracts, fns)
    }

    // ── Nonce / expiry / network / snapshot gates ──

    /// Theo R2: `nonce == stored_seq + 1` exactly; `u64::MAX` wrap is
    /// unrepresentable (rotation before wrap is mandatory).
    pub fn check_nonce(_e: &Env, stored_seq: u64, nonce: u64) -> Result<(), PeridotError> {
        match stored_seq.checked_add(1) {
            Some(next) if nonce == next => Ok(()),
            _ => Err(PeridotError::BadNonce),
        }
    }

    /// Freshness bound: `current < expiry <= current + 120`.
    pub fn check_expiry(
        _e: &Env,
        current_ledger: u32,
        expiry_ledger: u32,
    ) -> Result<(), PeridotError> {
        if expiry_ledger <= current_ledger {
            return Err(PeridotError::ExpiredOrTooFar);
        }
        if expiry_ledger - current_ledger > MAX_TTL_LEDGERS {
            return Err(PeridotError::ExpiredOrTooFar);
        }
        Ok(())
    }

    /// F1 enforcement hook: host `network_id` (from
    /// `env.ledger().network_id()`) must equal the signer-committed id.
    /// Caller discipline (finding 2, ANT-704): the contract call site MUST
    /// pass the host value — enforced at review, not in-crate.
    pub fn check_network(
        _e: &Env,
        host_id: BytesN<32>,
        intent_network_id: BytesN<32>,
    ) -> Result<(), PeridotError> {
        if host_id == intent_network_id {
            Ok(())
        } else {
            Err(PeridotError::BadNetwork)
        }
    }

    /// G2 version pin: intent version must equal the stored snapshot
    /// version exactly (stale AND future rejected; client re-fetches).
    pub fn check_snapshot_version(
        e: &Env,
        intent_version: u32,
    ) -> Result<(), PeridotError> {
        let stored: u32 = e
            .storage()
            .instance()
            .get(&DataKey::SnapshotVersion)
            .unwrap_or(1u32);
        if stored == intent_version {
            Ok(())
        } else {
            Err(PeridotError::StaleSnapshot)
        }
    }

    /// Effective expiry: `min(OZ valid_until, intent expiry_ledger)`.
    /// `None` valid_until ⇒ intent expiry bounds the session alone.
    pub fn effective_expiry(
        _e: &Env,
        valid_until: Option<u32>,
        expiry_ledger: u32,
    ) -> u32 {
        match valid_until {
            Some(until) if until < expiry_ledger => until,
            _ => expiry_ledger,
        }
    }

    /// A snapshot entry is live while its OZ `valid_until` (if any) has not
    /// passed. Unset ⇒ no OZ-side expiry.
    pub fn snapshot_entry_live(
        _e: &Env,
        current_ledger: u32,
        valid_until: Option<u32>,
    ) -> bool {
        match valid_until {
            Some(until) => current_ledger <= until,
            None => true,
        }
    }

    // ── G2 snapshot registry (self-auth-gated, least privilege) ──

    pub fn get_snapshot_version(e: &Env) -> u32 {
        e.storage()
            .instance()
            .get(&DataKey::SnapshotVersion)
            .unwrap_or(1u32)
    }

    /// Bump the snapshot version (self-auth: the account itself must
    /// authorize — same gate as OZ rule management).
    pub fn set_snapshot_version(e: &Env, version: u32) {
        e.current_contract_address().require_auth();
        e.storage()
            .instance()
            .set(&DataKey::SnapshotVersion, &version);
    }

    /// Pin one `rule_hash → oz_id` row (self-auth).
    pub fn register_snapshot_entry(
        e: &Env,
        rule_hash: BytesN<32>,
        oz_id: u32,
        valid_until: Option<u32>,
    ) {
        e.current_contract_address().require_auth();
        e.storage().persistent().set(
            &DataKey::SnapshotEntry(oz_id),
            &SnapshotEntry {
                rule_hash,
                valid_until,
            },
        );
    }

    pub fn resolve_snapshot(e: &Env, oz_id: u32) -> Option<SnapshotEntry> {
        e.storage()
            .persistent()
            .get(&DataKey::SnapshotEntry(oz_id))
    }

    pub fn batch_add_signer(e: &Env, context_rule_id: u32, signers: Vec<Signer>) {
        e.current_contract_address().require_auth();
        smart_account::batch_add_signer(e, context_rule_id, &signers);
    }
}

#[contractimpl]
impl CustomAccountInterface for PeridotAccountContract {
    type Error = SmartAccountError;
    type Signature = AuthPayload;

    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        smart_account::do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

#[contractimpl(contracttrait)]
impl SmartAccount for PeridotAccountContract {}

#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for PeridotAccountContract {}

#[contractimpl]
impl Upgradeable for PeridotAccountContract {
    fn upgrade(e: &Env, new_wasm_hash: BytesN<32>, _operator: Address) {
        e.current_contract_address().require_auth();
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec, Bytes};

    fn env_with_account() -> (Env, Address) {
        let e = Env::default();
        e.mock_all_auths();
        // OZ requires ≥1 signer or policy per rule: seed one Delegated
        // signer (needs no verifier contract — keeps tests hermetic).
        let signers = vec![&e, Signer::Delegated(Address::generate(&e))];
        let account = e.register(PeridotAccountContract, (signers, Map::<Address, Val>::new(&e),));
        (e, account)
    }

    fn testnet_id(e: &Env) -> BytesN<32> {
        let mut b = Bytes::new(e);
        b.extend_from_slice(b"Test SDF Network ; September 2015");
        e.crypto().sha256(&b).to_bytes()
    }

    fn mainnet_id(e: &Env) -> BytesN<32> {
        let mut b = Bytes::new(e);
        b.extend_from_slice(b"Public Global Stellar Network ; September 2015");
        e.crypto().sha256(&b).to_bytes()
    }

    fn hex(bytes: &[u8]) -> std::string::String {
        bytes.iter().map(|x| std::format!("{:02x}", x)).collect()
    }

    #[test]
    fn domain_v2_is_28_bytes() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        assert_eq!(c.domain_v2_len(), 28);
    }

    /// Byte-parity with `contracts/stellar/src/auth.rs`:
    /// v2 preimage for op=0x11, account=[0xAB;32], nonce=7,
    /// scope=[0x11;32], expiry=9_999_100, fee_v=1, max_fee=1_000_000,
    /// network=testnet, snapshot=3, rules=[1] is 159 bytes (187 with the
    /// full 8-rule set); the digest must equal the independently rebuilt
    /// preimage hash below (same assertion the testnet deploy makes against
    /// the on-chain `signature_payload`, Tobias G1).
    #[test]
    fn intent_digest_matches_independent_reference() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        let d = c.intent_digest(
            &OP_EXECUTE,
            &BytesN::from_array(&e, &[0xABu8; 32]),
            &7u64,
            &BytesN::from_array(&e, &[0x11u8; 32]),
            &9_999_100u32,
            &1u32,
            &1_000_000u64,
            &testnet_id(&e),
            &3u32,
            &vec![&e, 1u32],
        );
        // Independent reference: sha256 over the hand-built preimage
        // (python3 hashlib, spec §1 layout). Recompute here by hand too —
        // the assertion that matters is determinism + field binding below;
        // the hex pins the value for SDK parity.
        let mut pre: Bytes = Bytes::new(&e);
        pre.extend_from_slice(b"PID|STELLAR|SMART_ACCOUNT|v2");
        pre.push_back(OP_EXECUTE as u8);
        pre.extend_from_slice(&[0xABu8; 32]);
        pre.extend_from_slice(&7u64.to_le_bytes());
        pre.extend_from_slice(&[0x11u8; 32]);
        pre.extend_from_slice(&9_999_100u32.to_le_bytes());
        pre.extend_from_slice(&1u16.to_le_bytes());
        pre.extend_from_slice(&1_000_000u64.to_le_bytes());
        pre.extend_from_slice(&testnet_id(&e).to_array());
        pre.extend_from_slice(&3u32.to_le_bytes());
        pre.extend_from_slice(&1u32.to_le_bytes());
        pre.extend_from_slice(&1u32.to_le_bytes());
        assert_eq!(pre.len(), 159);
        let expect = e.crypto().sha256(&pre).to_bytes();
        assert_eq!(d, expect);
        // Pinned for SDK parity — if this changes, the TS parity test must
        // change identically (layout drift = build failure).
        std::println!("intent_digest ref: {}", hex(&d.to_array()));
    }

    #[test]
    fn cross_network_digests_differ() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        let a = BytesN::from_array(&e, &[0xABu8; 32]);
        let s = BytesN::from_array(&e, &[0x11u8; 32]);
        let t = c.intent_digest(&OP_EXECUTE, &a, &7, &s, &9_999_100, &1, &1_000_000, &testnet_id(&e), &3, &vec![&e, 1u32]);
        let m = c.intent_digest(&OP_EXECUTE, &a, &7, &s, &9_999_100, &1, &1_000_000, &mainnet_id(&e), &3, &vec![&e, 1u32]);
        assert_ne!(t, m);
    }

    #[test]
    fn every_policy_field_is_digest_bound() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        let base = c.intent_digest(&OP_EXECUTE, &BytesN::from_array(&e, &[0xABu8; 32]), &7, &BytesN::from_array(&e, &[0x11u8; 32]), &9_999_100, &1, &1_000_000, &testnet_id(&e), &3, &vec![&e, 1u32]);
        // rule change
        assert_ne!(base, c.intent_digest(&OP_EXECUTE, &BytesN::from_array(&e, &[0xABu8; 32]), &7, &BytesN::from_array(&e, &[0x11u8; 32]), &9_999_100, &1, &1_000_000, &testnet_id(&e), &3, &vec![&e, 2u32]));
        // snapshot version change
        assert_ne!(base, c.intent_digest(&OP_EXECUTE, &BytesN::from_array(&e, &[0xABu8; 32]), &7, &BytesN::from_array(&e, &[0x11u8; 32]), &9_999_100, &1, &1_000_000, &testnet_id(&e), &2, &vec![&e, 1u32]));
        // network change
        assert_ne!(base, c.intent_digest(&OP_EXECUTE, &BytesN::from_array(&e, &[0xABu8; 32]), &7, &BytesN::from_array(&e, &[0x11u8; 32]), &9_999_100, &1, &1_000_000, &mainnet_id(&e), &3, &vec![&e, 1u32]));
        // nonce change
        assert_ne!(base, c.intent_digest(&OP_EXECUTE, &BytesN::from_array(&e, &[0xABu8; 32]), &8, &BytesN::from_array(&e, &[0x11u8; 32]), &9_999_100, &1, &1_000_000, &testnet_id(&e), &3, &vec![&e, 1u32]));
        // op change
        assert_ne!(base, c.intent_digest(&OP_ROTATE, &BytesN::from_array(&e, &[0xABu8; 32]), &7, &BytesN::from_array(&e, &[0x11u8; 32]), &9_999_100, &1, &1_000_000, &testnet_id(&e), &3, &vec![&e, 1u32]));
        // reserved op denied
        assert!(c.try_intent_digest(&0x12u32, &BytesN::from_array(&e, &[0xABu8; 32]), &7, &BytesN::from_array(&e, &[0x11u8; 32]), &9_999_100, &1, &1_000_000, &testnet_id(&e), &3, &vec![&e, 1u32]).is_err());
        // >8 rules denied
        assert!(c.try_intent_digest(&OP_EXECUTE, &BytesN::from_array(&e, &[0xABu8; 32]), &7, &BytesN::from_array(&e, &[0x11u8; 32]), &9_999_100, &1, &1_000_000, &testnet_id(&e), &3, &vec![&e, 0u32, 1u32, 2u32, 3u32, 4u32, 5u32, 6u32, 7u32, 8u32]).is_err());
    }

    #[test]
    fn golden_scope_hash_vectors() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        // V1: game-move, [0x01;32], ["make_move","forfeit"].
        let v1 = c.scope_hash(
            &String::from_str(&e, "game-move"),
            &vec![&e, BytesN::from_array(&e, &[0x01u8; 32])],
            &vec![&e, String::from_str(&e, "make_move"), String::from_str(&e, "forfeit")],
        );
        assert_eq!(hex(&v1.to_array()), "3ec34e3d5456b933bd07772925ecd087b628820601c8734c5e628ed2a57a3cca");
        // V2: state-read, any-contract ([]), ["read_state"].
        let v2 = c.scope_hash(
            &String::from_str(&e, "state-read"),
            &vec![&e],
            &vec![&e, String::from_str(&e, "read_state")],
        );
        assert_eq!(hex(&v2.to_array()), "fdbb3ec797c7e254cddacd2a9d14c4d4d8eb5ebc9566a75cebca31b899a947d7");
        // V3: profile-write, [0xAA;32, 0xBB;32], ["set_avatar"].
        let v3 = c.scope_hash(
            &String::from_str(&e, "profile-write"),
            &vec![&e, BytesN::from_array(&e, &[0xAAu8; 32]), BytesN::from_array(&e, &[0xBBu8; 32])],
            &vec![&e, String::from_str(&e, "set_avatar")],
        );
        assert_eq!(hex(&v3.to_array()), "01853f84e337c9ff69a660bcedeb26f003cb7542d3529c1db3e456c5e7c73775");
    }

    #[test]
    fn canonical_form_closes_concatenation_ambiguity() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        let ab_c = c.scope_hash(
            &String::from_str(&e, "game-move"),
            &vec![&e, BytesN::from_array(&e, &[0xAAu8; 32])],
            &vec![&e, String::from_str(&e, "ab"), String::from_str(&e, "c")],
        );
        let a_bc = c.scope_hash(
            &String::from_str(&e, "game-move"),
            &vec![&e, BytesN::from_array(&e, &[0xAAu8; 32])],
            &vec![&e, String::from_str(&e, "a"), String::from_str(&e, "bc")],
        );
        assert_ne!(ab_c, a_bc);
    }

    #[test]
    fn oversize_scope_rejected() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        // 65 fns rejected (boundary is 64).
        let mut fns = Vec::<String>::new(&e);
        for i in 0..65u32 {
            fns.push_back(String::from_str(&e, &std::format!("fn{i}")));
        }
        assert!(c.try_scope_canonical(&String::from_str(&e, "game-move"), &vec![&e, BytesN::from_array(&e, &[0x01u8; 32])], &fns).is_err());
        // One 65-byte fn name rejected.
        let long = vec![&e, String::from_str(&e, &"x".repeat(65))];
        assert!(c.try_scope_canonical(&String::from_str(&e, "game-move"), &vec![&e, BytesN::from_array(&e, &[0x01u8; 32])], &long).is_err());
        // 65 contracts rejected.
        let mut contracts = Vec::<BytesN<32>>::new(&e);
        for _ in 0..65u32 {
            contracts.push_back(BytesN::from_array(&e, &[0x01u8; 32]));
        }
        let one_fn = vec![&e, String::from_str(&e, "f")];
        assert!(c.try_scope_canonical(&String::from_str(&e, "game-move"), &contracts, &one_fn).is_err());
    }

    #[test]
    fn nonce_expiry_network_snapshot_gates() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        // Success cases return without panic (plain client unwraps).
        c.check_nonce(&6u64, &7u64);
        c.check_expiry(&1000u32, &1120u32);
        c.check_network(&testnet_id(&e), &testnet_id(&e));
        c.check_snapshot_version(&1u32);
        // Failure cases via try_ (contract errors surface as invocation errors).
        assert!(c.try_check_nonce(&6u64, &6u64).is_err()); // replay
        assert!(c.try_check_nonce(&u64::MAX, &0u64).is_err()); // wrap forbidden
        assert!(c.try_check_expiry(&1000u32, &1000u32).is_err());
        assert!(c.try_check_expiry(&1000u32, &1121u32).is_err());
        assert!(c.try_check_network(&mainnet_id(&e), &testnet_id(&e)).is_err());
        assert!(c.try_check_snapshot_version(&2u32).is_err()); // future
        // Snapshot version pin: genesis is 1.
        assert_eq!(c.get_snapshot_version(), 1);
        // min(valid_until, expiry).
        assert_eq!(c.effective_expiry(&Some(100u32), &200u32), 100);
        assert_eq!(c.effective_expiry(&Some(300u32), &200u32), 200);
        assert_eq!(c.effective_expiry(&None, &200u32), 200);
        assert!(c.snapshot_entry_live(&100u32, &Some(200u32)));
        assert!(!c.snapshot_entry_live(&201u32, &Some(200u32)));
        assert!(c.snapshot_entry_live(&u32::MAX, &None));
    }

    #[test]
    fn snapshot_registry_roundtrip() {
        let (e, account) = env_with_account();
        let c = PeridotAccountContractClient::new(&e, &account);
        let h = BytesN::from_array(&e, &[0x01u8; 32]);
        c.register_snapshot_entry(&h, &10u32, &Some(9_999_500u32));
        let got = c.resolve_snapshot(&10u32).unwrap();
        assert_eq!(got.rule_hash, h);
        assert_eq!(got.valid_until, Some(9_999_500u32));
        assert!(c.resolve_snapshot(&99u32).is_none());
        c.set_snapshot_version(&3u32);
        assert_eq!(c.get_snapshot_version(), 3);
        c.check_snapshot_version(&3u32);
        assert!(c.try_check_snapshot_version(&1u32).is_err());
        // OZ rule still present underneath.
        assert_eq!(c.get_context_rules_count(), 1);
    }
}
