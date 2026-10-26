//! Experiment 4: nonfinancial-only context-rule catalogue (adversarial analogue).
//!
//! Strict session rule (ANT-542 §3, D3/D4): session keys NEVER move assets.
//! The Stellar catalogue (Theo spec ANT-553, ACCEPTED with R4–R5) allow-lists
//! nonfinancial calls only; any SAC token financial entrypoint (`transfer`,
//! `mint`, `burn`, `clawback`, `approve`, …) under a nonfinancial-only rule
//! MUST fail — the Soroban analogue of the V4 adversarial suite's
//! unauthorized-finance case.
//!
//! Deny check runs FIRST, before allow-list matching (R4 contractual
//! deny-first ordering); matching is exact, case-sensitive. Unknown fns fail
//! `UnknownRule` regardless of the deny-list (default-deny: the allow-list
//! is the gate, the deny-list is defense in depth).

use sha2::{Digest, Sha256};

/// Financial entrypoints that a nonfinancial-only rule must always deny.
/// Mirrors the SAC/token interface subset that moves value or grants.
pub const FINANCIAL_FNS: &[&str] = &[
    "transfer",
    "transfer_from",
    "mint",
    "burn",
    "burn_from",
    "clawback",
    "approve",
    "set_admin",
];

/// Closed allowed-class enumeration (Theo R5). All Phase-0 classes are
/// nonfinancial — no `Financial` class exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleClass {
    StateRead,
    GameMove,
    ProfileWrite,
    SessionAdminReadonly,
}

impl RuleClass {
    pub fn tag(&self) -> &'static str {
        match self {
            RuleClass::StateRead => "state-read",
            RuleClass::GameMove => "game-move",
            RuleClass::ProfileWrite => "profile-write",
            RuleClass::SessionAdminReadonly => "session-admin-readonly",
        }
    }

    pub fn is_non_financial(&self) -> bool {
        true // every Phase-0 class is nonfinancial by construction
    }
}

/// Rule ID derivation (Phase-1 P1, ANT-703 — hard cutover from the Phase-0
/// naive concatenation, which had a concatenation ambiguity:
/// `(["ab","c"])` vs `(["a","bc"])` hashed identically. Now defined over the
/// canonical scope bytes below, so the ambiguity is closed by construction.
/// Phase-0 fixture IDs are throwaway (no v1 migration, no dual-version).
pub fn rule_id_for(
    class: RuleClass,
    contracts: &[[u8; 32]],
    fns: &[String],
) -> Result<[u8; 32], RuleError> {
    Ok(scope_hash(class, contracts, fns)?)
}

/// Canonical scope descriptor encoding (Phase-1 P1, ANT-703 — T3).
///
/// Layout (fixed-width, length-prefixed, field-ordered — unambiguous by
/// construction):
/// `class_tag NUL ‖ n_contracts u32le ‖ contracts (32B each, granted order) ‖`
/// `n_fns u32le ‖ (fn_len u16le ‖ fn_bytes)*`.
///
/// - Granted contract order is significant (order-sensitive by design,
///   matching the order-sensitivity of intent `rule_ids`).
/// - Empty contract set (`n_contracts = 0` = any contract) stays distinct
///   from any non-empty set via the count prefix.
/// - Oversize descriptors are rejected with `ScopeTooLarge` at build time
///   (fail-closed at setup, never at call).
pub fn scope_canonical(
    class: RuleClass,
    contracts: &[[u8; 32]],
    fns: &[String],
) -> Result<Vec<u8>, RuleError> {
    if fns.len() > MAX_RULE_FNS {
        return Err(RuleError::ScopeTooLarge);
    }
    for f in fns {
        if f.len() > MAX_FN_BYTES {
            return Err(RuleError::ScopeTooLarge);
        }
    }
    let mut buf = Vec::with_capacity(
        class.tag().len() + 1 + 4 + 32 * contracts.len() + 4 + fns.iter().map(|f| 2 + f.len()).sum::<usize>(),
    );
    buf.extend_from_slice(class.tag().as_bytes());
    buf.push(0x00); // NUL terminator — keeps ("ab","c")-style tag joins unambiguous
    buf.extend_from_slice(&(contracts.len() as u32).to_le_bytes());
    for c in contracts {
        buf.extend_from_slice(c);
    }
    buf.extend_from_slice(&(fns.len() as u32).to_le_bytes());
    for f in fns {
        buf.extend_from_slice(&(f.len() as u16).to_le_bytes());
        buf.extend_from_slice(f.as_bytes());
    }
    Ok(buf)
}

/// Scope hash: `sha256` over [`scope_canonical`] bytes.
pub fn scope_hash(
    class: RuleClass,
    contracts: &[[u8; 32]],
    fns: &[String],
) -> Result<[u8; 32], RuleError> {
    let canonical = scope_canonical(class, contracts, fns)?;
    let out = Sha256::digest(&canonical);
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&out);
    Ok(hash)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleError {
    /// Attempted a financial call under a nonfinancial-only rule.
    UnauthorizedFinancialOp,
    /// Rule ID unknown to this account, or fn/contract not allow-listed.
    UnknownRule,
    /// Rule too large to register (> 64 fns, spec RECOMMENDED bound).
    RuleTooLarge,
    /// Scope descriptor too large to canonicalize (> [`MAX_RULE_FNS`] fns or
    /// any fn name longer than [`MAX_FN_BYTES`] bytes). Fail-closed at build.
    ScopeTooLarge,
}

/// Max bytes per function name in a canonical scope descriptor (T3).
/// Mirrors the spirit of [`MAX_RULE_FNS`]: names are short entrypoints.
pub const MAX_FN_BYTES: usize = 64;

/// Recommended registration bound on allow-list size (spec §2.4).
pub const MAX_RULE_FNS: usize = 64;

/// A context rule: which contract + function may be called in this context.
#[derive(Debug, Clone)]
pub struct ContextRule {
    pub id: [u8; 32],
    pub class: RuleClass,
    /// Contract ID allow-list for this rule (empty = any contract, fn still gated).
    pub contracts: Vec<[u8; 32]>,
    /// Function allow-list. Must never intersect [`FINANCIAL_FNS`].
    pub fns: Vec<String>,
}

impl ContextRule {
    /// Invariant: a rule can never name a financial fn (checked at
    /// registration — fail-closed at setup, not at call). Registers the
    /// `RuleTooLarge` bound as well.
    pub fn validate(&self) -> Result<(), RuleError> {
        if self.fns.len() > MAX_RULE_FNS {
            return Err(RuleError::RuleTooLarge);
        }
        if self.class.is_non_financial() {
            for f in &self.fns {
                if FINANCIAL_FNS.contains(&f.as_str()) {
                    return Err(RuleError::UnauthorizedFinancialOp);
                }
            }
        }
        Ok(())
    }

    /// Authorize one call under this rule. Deny-list FIRST (R4), then the
    /// contract/fn allow-list (default-deny → `UnknownRule`).
    pub fn authorize(&self, contract: &[u8; 32], fn_name: &str) -> Result<(), RuleError> {
        if FINANCIAL_FNS.contains(&fn_name) {
            return Err(RuleError::UnauthorizedFinancialOp);
        }
        if !self.contracts.is_empty() && !self.contracts.contains(contract) {
            return Err(RuleError::UnknownRule);
        }
        if !self.fns.iter().any(|f| f == fn_name) {
            return Err(RuleError::UnknownRule);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gameplay_rule() -> ContextRule {
        let fns = vec!["make_move".to_string(), "forfeit".to_string()];
        let contracts = vec![[0x01u8; 32]];
        ContextRule {
            id: rule_id_for(RuleClass::GameMove, &contracts, &fns).unwrap(),
            class: RuleClass::GameMove,
            contracts,
            fns,
        }
    }

    #[test]
    fn nonfinancial_calls_pass() {
        let r = gameplay_rule();
        r.validate().unwrap();
        assert!(r.authorize(&[0x01u8; 32], "make_move").is_ok());
    }

    /// The must-fail case: all 8 deny-listed fns under the gameplay rule
    /// (spec AC2.2 — draft covered 6, extended to the full 8 per R4).
    #[test]
    fn all_deny_listed_fns_must_fail_under_nonfinancial_rule() {
        let r = gameplay_rule();
        assert_eq!(FINANCIAL_FNS.len(), 8);
        for f in FINANCIAL_FNS {
            assert_eq!(
                r.authorize(&[0x01u8; 32], f),
                Err(RuleError::UnauthorizedFinancialOp),
                "financial fn `{}` must be denied",
                f
            );
        }
    }

    /// Spec AC2.5: exact, case-sensitive matching — `"Transfer"` is NOT the
    /// deny-listed `"transfer"`, but it is also NOT allow-listed, so it must
    /// still fail (as `UnknownRule`). Either error is acceptable; success is not.
    #[test]
    fn mixed_case_transfer_must_not_succeed() {
        let r = gameplay_rule();
        assert!(r.authorize(&[0x01u8; 32], "Transfer").is_err());
        assert!(r.authorize(&[0x01u8; 32], "TRANSFER").is_err());
    }

    /// Fail-closed at registration: a rule that names `transfer` is rejected
    /// before it can ever be stored (sponsor cannot smuggle it in later —
    /// rule IDs are digest-bound per `auth.rs`).
    #[test]
    fn registration_rejects_financial_fn_in_nonfinancial_rule() {
        let mut bad = gameplay_rule();
        bad.fns.push("transfer".into());
        assert_eq!(bad.validate(), Err(RuleError::UnauthorizedFinancialOp));
    }

    #[test]
    fn unknown_contract_or_fn_rejected() {
        let r = gameplay_rule();
        assert_eq!(r.authorize(&[0xFFu8; 32], "make_move"), Err(RuleError::UnknownRule));
        assert_eq!(r.authorize(&[0x01u8; 32], "withdraw"), Err(RuleError::UnknownRule));
    }

    #[test]
    fn rule_id_derivation_is_deterministic_and_class_bound() {
        let r1 = gameplay_rule();
        let r2 = gameplay_rule();
        assert_eq!(r1.id, r2.id);
        // Class is in the preimage: same sets, different class → different id.
        let fns = vec!["make_move".to_string(), "forfeit".to_string()];
        let contracts = vec![[0x01u8; 32]];
        assert_ne!(
            r1.id,
            rule_id_for(RuleClass::StateRead, &contracts, &fns).unwrap()
        );
    }

    /// T3 regression (ANT-703): the Phase-0 naive concatenation hashed
    /// `(["ab","c"])` and `(["a","bc"])` identically (ambiguity PoC
    /// `ee0ce23b…`). The canonical form length-prefixes every variable
    /// field, so the two descriptors MUST differ now.
    #[test]
    fn canonical_form_closes_concatenation_ambiguity() {
        let c_ab = [[0xAAu8; 32]]; // placeholder contract; ambiguity is in fns
        let fns_ab_c = vec!["ab".to_string(), "c".to_string()];
        let fns_a_bc = vec!["a".to_string(), "bc".to_string()];
        assert_ne!(
            rule_id_for(RuleClass::GameMove, &c_ab, &fns_ab_c).unwrap(),
            rule_id_for(RuleClass::GameMove, &c_ab, &fns_a_bc).unwrap()
        );
    }

    /// T3 binding tests: single-byte mutation in every section changes the
    /// hash; granted contract order is significant; `n_contracts = 0` (any
    /// contract) is distinct from `n_contracts = 1`.
    #[test]
    fn scope_hash_binds_every_field() {
        let contracts = vec![[0x01u8; 32]];
        let fns = vec!["make_move".to_string()];
        let base = scope_hash(RuleClass::GameMove, &contracts, &fns).unwrap();
        // One mutated contract byte.
        let mut bad_c = contracts.clone();
        bad_c[0][0] ^= 0x01;
        assert_ne!(base, scope_hash(RuleClass::GameMove, &bad_c, &fns).unwrap());
        // One mutated fn byte.
        let bad_f = vec!["make_movf".to_string()];
        assert_ne!(base, scope_hash(RuleClass::GameMove, &contracts, &bad_f).unwrap());
        // Class tag.
        assert_ne!(
            base,
            scope_hash(RuleClass::StateRead, &contracts, &fns).unwrap()
        );
        // Order sensitivity: [A,B] vs [B,A] contracts and [f,g] vs [g,f] fns.
        let ab = vec![[0x01u8; 32], [0x02u8; 32]];
        let ba = vec![[0x02u8; 32], [0x01u8; 32]];
        let fg = vec!["f".to_string(), "g".to_string()];
        let gf = vec!["g".to_string(), "f".to_string()];
        assert_ne!(
            scope_hash(RuleClass::GameMove, &ab, &fg).unwrap(),
            scope_hash(RuleClass::GameMove, &ba, &fg).unwrap()
        );
        assert_ne!(
            scope_hash(RuleClass::GameMove, &ab, &fg).unwrap(),
            scope_hash(RuleClass::GameMove, &ab, &gf).unwrap()
        );
        // Empty contract set (any-contract) vs one-contract: distinct.
        let empty: Vec<[u8; 32]> = vec![];
        assert_ne!(
            scope_hash(RuleClass::GameMove, &empty, &fns).unwrap(),
            scope_hash(RuleClass::GameMove, &contracts, &fns).unwrap()
        );
        // Deterministic.
        assert_eq!(base, scope_hash(RuleClass::GameMove, &contracts, &fns).unwrap());
    }

    /// T3 golden vectors (ANT-703): pinned descriptor→hash pairs shared
    /// with the TS SDK builder (`@peridotvault/pid-stellar` scope builder).
    /// If ANY of these change, the TS parity test must change identically —
    /// a mismatch means the canonical layouts diverged (fail the build).
    #[test]
    fn golden_scope_hash_vectors() {
        fn hex(b: &[u8]) -> String {
            b.iter().map(|x| format!("{:02x}", x)).collect()
        }
        // V1: game-move, [0x01;32], ["make_move","forfeit"].
        let v1 = scope_hash(
            RuleClass::GameMove,
            &[[0x01u8; 32]],
            &["make_move".to_string(), "forfeit".to_string()],
        )
        .unwrap();
        assert_eq!(
            hex(&v1),
            "3ec34e3d5456b933bd07772925ecd087b628820601c8734c5e628ed2a57a3cca"
        );
        // V2: state-read, any-contract ([]), ["read_state"].
        let v2 = scope_hash(RuleClass::StateRead, &[], &["read_state".to_string()]).unwrap();
        assert_eq!(
            hex(&v2),
            "fdbb3ec797c7e254cddacd2a9d14c4d4d8eb5ebc9566a75cebca31b899a947d7"
        );
        // V3: profile-write, [0xAA;32, 0xBB;32], ["set_avatar"].
        let v3 = scope_hash(
            RuleClass::ProfileWrite,
            &[[0xAAu8; 32], [0xBBu8; 32]],
            &["set_avatar".to_string()],
        )
        .unwrap();
        assert_eq!(
            hex(&v3),
            "01853f84e337c9ff69a660bcedeb26f003cb7542d3529c1db3e456c5e7c73775"
        );
    }
    #[test]
    fn oversize_scope_rejected() {
        let contracts = vec![[0x01u8; 32]];
        let many: Vec<String> = (0..65).map(|i| format!("fn{i}")).collect();
        assert_eq!(
            scope_canonical(RuleClass::GameMove, &contracts, &many),
            Err(RuleError::ScopeTooLarge)
        );
        let long = vec!["x".repeat(65)];
        assert_eq!(
            scope_canonical(RuleClass::GameMove, &contracts, &long),
            Err(RuleError::ScopeTooLarge)
        );
        // Boundary: 64 fns of 64 bytes each is accepted.
        let max_fns: Vec<String> = (0..64).map(|i| format!("fn{i:0>62}")).collect();
        assert!(scope_canonical(RuleClass::GameMove, &contracts, &max_fns).is_ok());
    }
}
