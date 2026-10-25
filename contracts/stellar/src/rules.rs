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

/// Rule ID derivation (spec §2.1): `id = sha256(class ‖ contract-set ‖ fn-set)`.
pub fn rule_id_for(class: RuleClass, contracts: &[[u8; 32]], fns: &[String]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(class.tag().as_bytes());
    for c in contracts {
        h.update(c);
    }
    for f in fns {
        h.update(f.as_bytes());
    }
    h.finalize().into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleError {
    /// Attempted a financial call under a nonfinancial-only rule.
    UnauthorizedFinancialOp,
    /// Rule ID unknown to this account, or fn/contract not allow-listed.
    UnknownRule,
    /// Rule too large to register (> 64 fns, spec RECOMMENDED bound).
    RuleTooLarge,
}

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
            id: rule_id_for(RuleClass::GameMove, &contracts, &fns),
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
            rule_id_for(RuleClass::StateRead, &contracts, &fns)
        );
    }
}
