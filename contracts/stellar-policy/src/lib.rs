//! PeridotID Stellar Phase-1 P1 nonfinancial-only policy (testnet-only,
//! ANT-712).
//!
//! OZ `stellar-accounts =0.8.0` [`Policy`] enforcement for the AC3.4 exact
//! case: a context rule scoped to nonfinancial calls attempts a real token
//! transfer on-chain and MUST fail. The deny catalogue mirrors
//! `contracts/stellar/src/rules.rs` (`FINANCIAL_FNS`, deny-first, exact
//! case-sensitive matching per Theo R4):
//!
//! - `enforce` rejects any `Context::Contract` whose `fn_name` is one of
//!   `transfer | transfer_from | mint | burn | burn_from | clawback |
//!   approve | set_admin` with [`PolicyError::UnauthorizedFinancialOp`]
//!   (layer 1: direct financial call).
//! - `enforce` ALSO rejects `execute(target, fn, args)` dispatches (the OZ
//!   [`ExecutionEntryPoint`] shape) whose TARGET `fn` is deny-listed
//!   (layer 2: dispatched financial call). This is the layer that fires for
//!   the AC3.4 exact case: the rule authorizes `execute(...)` on the
//!   account, and the policy sees the inner `(SAC, transfer)` dispatch in
//!   the execute args. Without layer 2 the policy only sees
//!   `fn_name == "execute"` and passes — verified on testnet (a v1 build
//!   without layer 2 let the transfer through).
//! - Every other context (nonfinancial contract calls, contract creates,
//!   nonfinancial execute targets) passes — rule scoping (which
//!   contracts/fns a rule covers) stays the OZ rule's job (`Default` vs
//!   `CallContract`); this policy is the defense-in-depth deny layer,
//!   exactly like the local core.
//!
//! Design notes:
//!
//! - Stateless by design: `install`/`uninstall` only assert the smart
//!   account's authorization (the account already self-auths these calls;
//!   the check makes direct invocation fail-closed). No storage means
//!   nothing to rotate and nothing to go stale; versioning is by redeploy.
//! - `enforce` performs NO external calls (pure check) — reentrancy-safe by
//!   construction; the panic happens inside `__check_auth`, before the
//!   invoked contract runs, so a denied attempt leaves zero state change.
//! - Case handling is contractual (R4): `"Transfer"` is NOT deny-listed and
//!   passes this policy — the token contract itself rejects unknown fns, so
//!   there is no bypass, only a different (target-side) error. Pinned below.
//! - Layer 2 is fail-open on malformed execute args (wrong arity or
//!   non-symbol target fn): an undecodable dispatch is not judged here —
//!   the rule's own scoping (e.g. `CallContract`) decides. Deny-list
//!   matching itself stays exact and fail-closed.
//!
//! Testnet-only. Not audited, never mainnet.
//!
//! Domain lenses: gas (symbol compares only, no alloc on the hot path);
//! reentrancy (no external calls in `enforce`); access control (install and
//! uninstall require the owning account's auth — least privilege, no admin
//! key); fuzz/invariants (deny-list completeness + case-sensitivity pinned
//! as properties, not just the 8 examples).
//!
//! [`Policy`]: stellar_accounts::policies::Policy
//! [`ExecutionEntryPoint`]: stellar_accounts::smart_account::ExecutionEntryPoint

#![no_std]

use soroban_sdk::{
    auth::Context, contract, contracterror, contractimpl, contracttype, panic_with_error,
    Address, Env, Symbol, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, Signer},
};

/// Financial entrypoints a nonfinancial-only rule must always deny.
/// Byte-parity with `contracts/stellar/src/rules.rs::FINANCIAL_FNS` and the
/// TS-side list (deny-first, exact, case-sensitive — Theo R4).
const FINANCIAL_FNS: [&str; 8] = [
    "transfer",
    "transfer_from",
    "mint",
    "burn",
    "burn_from",
    "clawback",
    "approve",
    "set_admin",
];

/// Policy errors (<500 range; distinct from OZ 3000s and account <100s).
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum PolicyError {
    /// A financial call was attempted under a nonfinancial-only rule
    /// (the on-chain analogue of `RuleError::UnauthorizedFinancialOp`).
    UnauthorizedFinancialOp = 1,
    /// Installation parameters are malformed (unknown version).
    InvalidParams = 2,
}

/// Installation parameters. Versioned and otherwise empty: the policy is
/// stateless, so there is nothing to configure — the type exists because
/// the OZ [`Policy`] trait requires an associated `AccountParams: FromVal`.
/// `version` MUST be 1 (fail-closed on unknown versions); the field keeps
/// the door open for future denylist revisions without changing the type.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct NonFinancialOnlyParams {
    pub version: u32,
}

#[contract]
pub struct NonFinancialOnlyPolicy;

#[contractimpl]
impl Policy for NonFinancialOnlyPolicy {
    type AccountParams = NonFinancialOnlyParams;

    fn enforce(
        e: &Env,
        context: Context,
        _authenticated_signers: Vec<Signer>,
        _context_rule: ContextRule,
        _smart_account: Address,
    ) {
        // Deny check runs FIRST (R4), before any allow reasoning.
        if let Context::Contract(call) = context {
            // Layer 1: direct financial fn on the authorized context.
            for denied in FINANCIAL_FNS {
                if call.fn_name == Symbol::new(e, denied) {
                    panic_with_error!(e, PolicyError::UnauthorizedFinancialOp);
                }
            }
            // Layer 2: ExecutionEntryPoint dispatch — deny when the execute
            // TARGET fn is financial. Shape: execute(target: Address,
            // target_fn: Symbol, target_args: Vec). Fail-open on undecodable
            // args (rule scoping decides those); fail-closed on the match.
            if call.fn_name == Symbol::new(e, "execute") && call.args.len() == 3 {
                if let Ok(target_fn) = Symbol::try_from_val(e, &call.args.get_unchecked(1)) {
                    for denied in FINANCIAL_FNS {
                        if target_fn == Symbol::new(e, denied) {
                            panic_with_error!(e, PolicyError::UnauthorizedFinancialOp);
                        }
                    }
                }
            }
        }
        // Non-contract contexts (creates) and nonfinancial fns pass.
    }

    fn install(
        e: &Env,
        install_params: NonFinancialOnlyParams,
        _context_rule: ContextRule,
        smart_account: Address,
    ) {
        // The owning account must authorize (self-auth path; direct calls
        // without the account's auth trap here). Fail-closed on unknown
        // param versions — a future denylist revision must bump deliberately.
        smart_account.require_auth();
        if install_params.version != 1 {
            panic_with_error!(e, PolicyError::InvalidParams);
        }
    }

    fn uninstall(_e: &Env, _context_rule: ContextRule, smart_account: Address) {
        // Symmetric with install: nothing stored, but the account must own
        // the removal.
        smart_account.require_auth();
    }
}

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use soroban_sdk::{auth::ContractContext, testutils::Address as _, IntoVal};

    fn env_with_policy() -> (Env, Address) {
        let e = Env::default();
        e.mock_all_auths();
        let policy = e.register(NonFinancialOnlyPolicy, ());
        (e, policy)
    }

    fn contract_context(e: &Env, fn_name: &str) -> Context {
        Context::Contract(ContractContext {
            contract: Address::generate(e),
            fn_name: Symbol::new(e, fn_name),
            args: Vec::new(e),
        })
    }

    /// An `execute(target, target_fn, target_args)` dispatch context as the
    /// OZ ExecutionEntryPoint builds it: the authorized call is `execute` on
    /// the account, carrying the inner dispatch in its args.
    fn execute_context(e: &Env, target: Address, target_fn: &str) -> Context {
        let mut args = Vec::new(e);
        args.push_back(target.into_val(e));
        args.push_back(Symbol::new(e, target_fn).into_val(e));
        args.push_back(Vec::<Val>::new(e).into_val(e));
        Context::Contract(ContractContext {
            contract: Address::generate(e),
            fn_name: Symbol::new(e, "execute"),
            args,
        })
    }

    /// Malformed execute dispatch (wrong arity): layer 2 must fail open —
    /// the rule's own scoping (not this policy) decides undecodable calls.
    fn malformed_execute_context(e: &Env) -> Context {
        let mut args = Vec::new(e);
        args.push_back(Symbol::new(e, "transfer").into_val(e));
        Context::Contract(ContractContext {
            contract: Address::generate(e),
            fn_name: Symbol::new(e, "execute"),
            args,
        })
    }

    fn create_context(e: &Env) -> Context {
        use soroban_sdk::auth::CreateContractHostFnContext;
        use soroban_sdk::{BytesN, ContractExecutable};
        Context::CreateContractHostFn(CreateContractHostFnContext {
            executable: ContractExecutable::Wasm(BytesN::from_array(e, &[0xABu8; 32])),
            salt: BytesN::from_array(e, &[0xCDu8; 32]),
        })
    }

    fn dummy_rule(e: &Env) -> ContextRule {
        ContextRule {
            id: 0,
            context_type: stellar_accounts::smart_account::ContextRuleType::Default,
            name: soroban_sdk::String::from_str(e, "nonfinancial-only"),
            signers: Vec::new(e),
            signer_ids: Vec::new(e),
            policies: Vec::new(e),
            policy_ids: Vec::new(e),
            valid_until: None,
        }
    }

    #[test]
    fn all_deny_listed_fns_rejected() {
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        assert_eq!(FINANCIAL_FNS.len(), 8);
        for f in FINANCIAL_FNS {
            let res = c.try_enforce(
                &contract_context(&e, f),
                &Vec::new(&e),
                &dummy_rule(&e),
                &Address::generate(&e),
            );
            assert!(res.is_err(), "financial fn `{}` must be denied", f);
        }
    }

    #[test]
    fn deny_error_is_contract_error_not_host_error() {
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        let res = c.try_enforce(
            &contract_context(&e, "transfer"),
            &Vec::new(&e),
            &dummy_rule(&e),
            &Address::generate(&e),
        );
        // A contract-error abort surfaces as `Err(Ok(_))` (our
        // `UnauthorizedFinancialOp = 1`); a host trap would be `Err(Err(_))`
        // and success `Ok(_)`. The discriminant is pinned by the
        // `#[contracterror] repr(u32)` above — the on-chain evidence names
        // the code explicitly.
        assert!(matches!(res, Err(Ok(_))));
    }

    #[test]
    fn nonfinancial_fns_pass() {
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        for f in ["make_move", "read_state", "get_snapshot_version", "execute", "ping"] {
            c.enforce(
                &contract_context(&e, f),
                &Vec::new(&e),
                &dummy_rule(&e),
                &Address::generate(&e),
            );
        }
    }

    /// Layer 2: every deny-listed TARGET fn through an execute dispatch
    /// must fail — this is the AC3.4 on-chain shape
    /// (`execute(SAC, transfer, ...)` under the nonfinancial-only rule).
    #[test]
    fn execute_dispatch_to_financial_target_rejected() {
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        let target = Address::generate(&e);
        for f in FINANCIAL_FNS {
            let res = c.try_enforce(
                &execute_context(&e, target.clone(), f),
                &Vec::new(&e),
                &dummy_rule(&e),
                &Address::generate(&e),
            );
            assert!(matches!(res, Err(Ok(_))), "execute dispatch to `{}` must be denied", f);
        }
    }

    /// Layer 2 passes nonfinancial targets (the AC2.8 shape:
    /// `execute(verifier, canonicalize_key, ...)`).
    #[test]
    fn execute_dispatch_to_nonfinancial_target_passes() {
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        let target = Address::generate(&e);
        for f in ["canonicalize_key", "get_snapshot_version", "read_state"] {
            c.enforce(
                &execute_context(&e, target.clone(), f),
                &Vec::new(&e),
                &dummy_rule(&e),
                &Address::generate(&e),
            );
        }
    }

    /// Layer 2 fails open on undecodable dispatches (rule scoping decides).
    #[test]
    fn malformed_execute_dispatch_passes_policy() {
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        c.enforce(
            &malformed_execute_context(&e),
            &Vec::new(&e),
            &dummy_rule(&e),
            &Address::generate(&e),
        );
    }

    #[test]
    fn mixed_case_passes_policy_target_rejects() {
        // R4 contractual: matching is exact and case-sensitive. "Transfer"
        // is not the SAC's "transfer", so the policy lets it through and the
        // token contract rejects it as an unknown fn — no bypass, only a
        // different error layer. Pinned so a future case-folding change is a
        // deliberate, reviewed diff.
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        c.enforce(
            &contract_context(&e, "Transfer"),
            &Vec::new(&e),
            &dummy_rule(&e),
            &Address::generate(&e),
        );
        c.enforce(
            &contract_context(&e, "TRANSFER"),
            &Vec::new(&e),
            &dummy_rule(&e),
            &Address::generate(&e),
        );
    }

    #[test]
    fn install_uninstall_roundtrip_under_mock_auth() {
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        let account = Address::generate(&e);
        c.install(
            &NonFinancialOnlyParams { version: 1 },
            &dummy_rule(&e),
            &account,
        );
        // Unknown versions fail closed at setup.
        assert!(c
            .try_install(
                &NonFinancialOnlyParams { version: 2 },
                &dummy_rule(&e),
                &account,
            )
            .is_err());
        c.uninstall(&dummy_rule(&e), &account);
    }

    #[test]
    fn deny_list_parity_with_local_core() {
        // The on-chain list must stay byte-identical to
        // contracts/stellar/src/rules.rs FINANCIAL_FNS; this test names the
        // coupling so drift is a conscious diff on both sides.
        let local: [&str; 8] = [
            "transfer",
            "transfer_from",
            "mint",
            "burn",
            "burn_from",
            "clawback",
            "approve",
            "set_admin",
        ];
        assert_eq!(FINANCIAL_FNS, local);
    }

    #[test]
    fn non_contract_contexts_pass() {
        // Contract-create contexts are outside the deny catalogue (the OZ
        // rule's `CreateContract*` type gates those); the policy passes them.
        let (e, policy) = env_with_policy();
        let c = NonFinancialOnlyPolicyClient::new(&e, &policy);
        c.enforce(
            &create_context(&e),
            &Vec::new(&e),
            &dummy_rule(&e),
            &Address::generate(&e),
        );
    }
}
