//! Experiment 4: nonfinancial-only context-rule catalogue (adversarial analogue).
//!
//! Strict session rule (ANT-542 §3, D3/D4): session keys NEVER move assets.
//! The Stellar catalogue therefore allow-lists nonfinancial calls only; any
//! SAC token financial entrypoint (`transfer`, `mint`, `burn`, `clawback`,
//! `approve`, …) under a nonfinancial-only rule MUST fail — the Soroban
//! analogue of the V4 adversarial suite's unauthorized-finance case.

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleError {
    /// Attempted a financial call under a nonfinancial-only rule.
    UnauthorizedFinancialOp,
    /// Rule ID unknown to this account.
    UnknownRule,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleClass {
    /// Session-safe: state reads, game moves, profile writes — never value.
    NonFinancial,
}

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
    /// Invariant: a NonFinancial rule can never name a financial fn.
    /// Checked at rule registration (fail-closed at setup, not at call).
    pub fn validate(&self) -> Result<(), RuleError> {
        if self.class == RuleClass::NonFinancial {
            for f in &self.fns {
                if FINANCIAL_FNS.contains(&f.as_str()) {
                    return Err(RuleError::UnauthorizedFinancialOp);
                }
            }
        }
        Ok(())
    }

    /// Authorize one call under this rule.
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
    use sha2::{Digest, Sha256};

    fn rule_id(name: &str) -> [u8; 32] {
        Sha256::digest(name.as_bytes()).into()
    }

    fn gameplay_rule() -> ContextRule {
        ContextRule {
            id: rule_id("gameplay-moves"),
            class: RuleClass::NonFinancial,
            contracts: vec![[0x01u8; 32]],
            fns: vec!["make_move".into(), "forfeit".into()],
        }
    }

    #[test]
    fn nonfinancial_calls_pass() {
        let r = gameplay_rule();
        r.validate().unwrap();
        assert!(r.authorize(&[0x01u8; 32], "make_move").is_ok());
    }

    /// The must-fail case: token `transfer` under the gameplay rule.
    #[test]
    fn token_transfer_must_fail_under_nonfinancial_rule() {
        let r = gameplay_rule();
        for f in ["transfer", "mint", "burn", "clawback", "approve", "transfer_from"] {
            assert_eq!(
                r.authorize(&[0x01u8; 32], f),
                Err(RuleError::UnauthorizedFinancialOp),
                "financial fn `{}` must be denied",
                f
            );
        }
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
}
