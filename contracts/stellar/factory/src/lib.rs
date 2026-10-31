//! PeridotID Stellar Phase-1 P1 factory (testnet-only, ANT-711).
//!
//! Counterfactual deploys for the [`peridot-stellar-account`] smart
//! account: `salt = sha256(normalize(pid))` (full 32B, byte-identical to
//! `pidToSeed32` in `packages/core/src/bytes.ts` and to
//! `pid_to_salt32` in `contracts/stellar/src/salt.rs`), deployed via
//! `env.deployer().with_address(deployer, salt)`.
//!
//! - `normalize_pid`: trim ASCII whitespace + lowercase ASCII (byte-parity
//!   with the local core for ASCII pids; testnet pids are ASCII).
//! - Non-32B salts are rejected fail-closed (AC1.7): the typed entrypoints
//!   take `BytesN<32>` (the host enforces the length before our code runs)
//!   and the `*_bytes` variants explicitly check `len == 32`
//!   (`InvalidSaltLen`), mirroring `check_salt_len` in the local core.
//! - Distinct pids yield distinct salts/addresses (AC1.6).
//! - The account wasm hash is pinned at construction (`__constructor`);
//!   the factory instantiates ONLY that wasm. Permissionless deploy (anyone
//!   may call — like the OZ example factory) with one explicit caveat: the
//!   counterfactual namespace belongs to `deployer`, so the host requires
//!   the deployer's authorization on `deploy`.
//!
//! Testnet-only. Not audited, never mainnet.
//!
//! Domain lenses: gas (BytesN<32> calldata, no alloc on the hot path —
//! normalize builds one host Bytes); reentrancy (no external calls except
//! the terminal deploy; all checks run before it); access control (wasm pin
//! is constructor-only, least privilege — no admin key); oracle risk (none
//! — salt is pure sha256); upgradeability (immutable pin: to rotate the
//! account code, deploy a new factory — recorded, not silent);
//! reorg/finality (address = f(network, deployer, salt): `predict_*`
//! MUST equal the deployed address — asserted in tests and again on-chain
//! at deploy time by Trevor, ANT-710); key management (test keys only).

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Bytes, BytesN,
    ContractExecutable, Env, Map, String, Val, Vec,
};
use stellar_accounts::smart_account::{validate_no_canonical_duplicates, Signer};

#[contracttype]
enum DataKey {
    AccountWasmHash,
}

/// Factory errors (<100 range, per OZ convention).
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum FactoryError {
    /// Salt is not exactly 32 bytes (AC1.7 fail-closed).
    InvalidSaltLen = 1,
    /// Normalized pid is empty (mirrors the local core `invalid pid` assert).
    EmptyPid = 2,
}

#[contract]
pub struct PeridotFactoryContract;

#[contractimpl]
impl PeridotFactoryContract {
    /// Pins the account wasm hash every deployment instantiates.
    pub fn __constructor(e: &Env, account_wasm_hash: BytesN<32>) {
        e.storage()
            .instance()
            .set(&DataKey::AccountWasmHash, &account_wasm_hash);
    }

    /// The pinned account wasm hash.
    pub fn pinned_account_wasm_hash(e: &Env) -> BytesN<32> {
        e.storage()
            .instance()
            .get(&DataKey::AccountWasmHash)
            .expect("the account wasm hash is set in __constructor")
    }

    // ── pid → salt (S1 §1, byte-parity with salt.rs) ──

    /// Trim ASCII whitespace (both ends) + lowercase ASCII.
    pub fn normalize_pid(e: &Env, pid: String) -> String {
        let raw: Bytes = pid.to_bytes();
        let n = raw.len();
        let mut start = 0u32;
        let mut end = n;
        while start < end {
            let b = raw.get_unchecked(start);
            if b == 0x20 || (0x09..=0x0D).contains(&b) {
                start += 1;
            } else {
                break;
            }
        }
        while end > start {
            let b = raw.get_unchecked(end - 1);
            if b == 0x20 || (0x09..=0x0D).contains(&b) {
                end -= 1;
            } else {
                break;
            }
        }
        let mut out = Bytes::new(e);
        let mut i = start;
        while i < end {
            let mut b = raw.get_unchecked(i);
            if (b'A'..=b'Z').contains(&b) {
                b += 32;
            }
            out.push_back(b);
            i += 1;
        }
        out.to_string()
    }

    fn normalize_bytes(e: &Env, pid: &String) -> Result<Bytes, FactoryError> {
        let raw: Bytes = pid.to_bytes();
        let n = raw.len();
        let mut start = 0u32;
        let mut end = n;
        while start < end {
            let b = raw.get_unchecked(start);
            if b == 0x20 || (0x09..=0x0D).contains(&b) {
                start += 1;
            } else {
                break;
            }
        }
        while end > start {
            let b = raw.get_unchecked(end - 1);
            if b == 0x20 || (0x09..=0x0D).contains(&b) {
                end -= 1;
            } else {
                break;
            }
        }
        if start == end {
            return Err(FactoryError::EmptyPid);
        }
        let mut out = Bytes::new(e);
        let mut i = start;
        while i < end {
            let mut b = raw.get_unchecked(i);
            if (b'A'..=b'Z').contains(&b) {
                b += 32;
            }
            out.push_back(b);
            i += 1;
        }
        Ok(out)
    }

    /// `pid_to_salt32(pid) = sha256(normalize(pid))`, full 32B.
    /// Panics `EmptyPid` on blank input (fail-closed, like the local core).
    pub fn pid_to_salt(e: &Env, pid: String) -> Result<BytesN<32>, FactoryError> {
        let norm = Self::normalize_bytes(e, &pid)?;
        Ok(e.crypto().sha256(&norm).to_bytes())
    }

    /// Fail-closed salt-length gate (AC1.7 on-chain): exactly 32 bytes.
    pub fn check_salt_len(_e: &Env, salt: Bytes) -> Result<(), FactoryError> {
        if salt.len() == 32 {
            Ok(())
        } else {
            Err(FactoryError::InvalidSaltLen)
        }
    }

    // ── counterfactual predict / deploy ──

    /// Address `deploy_with_salt` creates for `(deployer, salt)` — whether
    /// or not the account exists yet.
    pub fn predict_address(
        e: &Env,
        deployer: Address,
        salt: BytesN<32>,
    ) -> Address {
        e.deployer()
            .with_address(deployer, salt)
            .deployed_address()
    }

    /// `predict_address` for the salt of a pid.
    pub fn predict_for_pid(
        e: &Env,
        deployer: Address,
        pid: String,
    ) -> Result<Address, FactoryError> {
        let salt = Self::pid_to_salt(e, pid)?;
        Ok(Self::predict_address(e, deployer, salt))
    }

    /// Variable-length salt entrypoint with the explicit fail-closed gate:
    /// non-32B salts are rejected with `InvalidSaltLen` before deploy.
    pub fn predict_with_salt_bytes(
        e: &Env,
        deployer: Address,
        salt: Bytes,
    ) -> Result<Address, FactoryError> {
        Self::check_salt_len(e, salt.clone())?;
        let mut arr = [0u8; 32];
        salt.copy_into_slice(&mut arr);
        let salt32 = BytesN::from_array(e, &arr);
        Ok(Self::predict_address(e, deployer, salt32))
    }

    fn deploy_inner(
        e: &Env,
        deployer: Address,
        salt: BytesN<32>,
        signers: Vec<Signer>,
        policies: Map<Address, Val>,
    ) -> Address {
        // Checks-first (finding: on-chain Auth.InvalidAction, ANT-710):
        // `with_address(deployer, salt)` deploys INTO the deployer's
        // counterfactual namespace, so the host requires the deployer's
        // authorization tied to this (root) invocation. Without this node
        // the simulator records no auth for the deployer and the VM traps
        // at `create_contract_with_constructor`. Predict paths are
        // unaffected (no host deploy).
        deployer.require_auth();
        let wasm_hash = Self::pinned_account_wasm_hash(e);
        // Reject duplicates FIRST on the caller-supplied order (OZ/
        // verifier-canonical), then sort — so the constructor args, and
        // hence the deployed account, are canonical. (Checking after the
        // Map fold would silently collapse duplicates instead of failing.)
        validate_no_canonical_duplicates(e, &signers);
        let mut set: Map<Signer, ()> = Map::new(e);
        for s in signers.iter() {
            set.set(s, ());
        }
        let canonical: Vec<Signer> = set.keys();
        e.deployer().with_address(deployer, salt).deploy_contract(
            ContractExecutable::Wasm(wasm_hash),
            (canonical, policies),
        )
    }

    /// Deploy the account for a pid. Salt is derived, never caller-supplied.
    /// The host requires the deployer's authorization (counterfactual
    /// namespace belongs to `deployer`).
    pub fn deploy(
        e: &Env,
        deployer: Address,
        pid: String,
        signers: Vec<Signer>,
        policies: Map<Address, Val>,
    ) -> Result<Address, FactoryError> {
        let salt = Self::pid_to_salt(e, pid)?;
        Ok(Self::deploy_inner(e, deployer, salt, signers, policies))
    }

    /// Deploy with an explicit 32B salt (typed path — the host enforces the
    /// length before our code runs).
    pub fn deploy_with_salt(
        e: &Env,
        deployer: Address,
        salt: BytesN<32>,
        signers: Vec<Signer>,
        policies: Map<Address, Val>,
    ) -> Address {
        Self::deploy_inner(e, deployer, salt, signers, policies)
    }

    /// Deploy with a variable-length salt: non-32B rejected fail-closed.
    pub fn deploy_with_salt_bytes(
        e: &Env,
        deployer: Address,
        salt: Bytes,
        signers: Vec<Signer>,
        policies: Map<Address, Val>,
    ) -> Result<Address, FactoryError> {
        Self::check_salt_len(e, salt.clone())?;
        let mut arr = [0u8; 32];
        salt.copy_into_slice(&mut arr);
        let salt32 = BytesN::from_array(e, &arr);
        Ok(Self::deploy_inner(e, deployer, salt32, signers, policies))
    }
}

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use soroban_sdk::{testutils::Address as _, vec};

    mod account {
        // Canonical deploy artifact (also what Trevor uploads on testnet).
        soroban_sdk::contractimport!(file = "../account/wasm/peridot_stellar_account.wasm");
    }

    fn setup(e: &Env) -> Address {
        let wasm_hash = e.deployer().upload_contract_wasm(account::WASM);
        e.register(PeridotFactoryContract, (wasm_hash,))
    }

    fn hex(bytes: &[u8]) -> std::string::String {
        bytes.iter().map(|x| std::format!("{:02x}", x)).collect()
    }

    #[test]
    fn pid_to_salt_matches_local_core_vectors() {
        let e = Env::default();
        let factory = setup(&e);
        let c = PeridotFactoryContractClient::new(&e, &factory);
        // Cross-checked against `packages/core` pidToSeed32 (node) — same
        // vectors as contracts/stellar/src/salt.rs.
        assert_eq!(
            hex(&c.pid_to_salt(&String::from_str(&e, "ifal@pid")).to_array()),
            "98bc15cccd4fd3a85b71e5b29b430d0cc461e7b5ebb7ac1b13428299ce52cfe7"
        );
        assert_eq!(
            hex(&c.pid_to_salt(&String::from_str(&e, "TEST@PID")).to_array()),
            "d7824b7df5f3b280b67abf3ac397749789aa4b6bac508d9b0df69091cb3a0cfa"
        );
        assert_eq!(
            hex(&c.pid_to_salt(&String::from_str(&e, "  Alice@PID  ")).to_array()),
            "12fcda9267d62d47b2aebd88a35cc04c5d929d0ddc3b1c14799c04fa233eef4e"
        );
    }

    #[test]
    fn normalize_trims_and_lowercases() {
        let e = Env::default();
        let factory = setup(&e);
        let c = PeridotFactoryContractClient::new(&e, &factory);
        assert_eq!(
            c.normalize_pid(&String::from_str(&e, "  CAROL@PID ")),
            String::from_str(&e, "carol@pid")
        );
        assert_eq!(
            c.pid_to_salt(&String::from_str(&e, "carol@pid")),
            c.pid_to_salt(&String::from_str(&e, "  CAROL@PID "))
        );
        // Blank pid fail-closed.
        assert!(c.try_pid_to_salt(&String::from_str(&e, "   ")).is_err());
    }

    #[test]
    fn distinct_pids_distinct_salts_ac16() {
        let e = Env::default();
        let factory = setup(&e);
        let c = PeridotFactoryContractClient::new(&e, &factory);
        assert_ne!(
            c.pid_to_salt(&String::from_str(&e, "alice@pid")),
            c.pid_to_salt(&String::from_str(&e, "bob@pid"))
        );
    }

    #[test]
    fn non_32b_salt_rejected_fail_closed_ac17() {
        let e = Env::default();
        let factory = setup(&e);
        let c = PeridotFactoryContractClient::new(&e, &factory);
        c.check_salt_len(&Bytes::from_slice(&e, &[0u8; 32]));
        assert!(c.try_check_salt_len(&Bytes::from_slice(&e, &[0u8; 4])).is_err());
        assert!(c.try_check_salt_len(&Bytes::from_slice(&e, &[0u8; 8])).is_err());
        assert!(c.try_check_salt_len(&Bytes::new(&e)).is_err());
        assert!(c.try_check_salt_len(&Bytes::from_slice(&e, &[0u8; 31])).is_err());
        assert!(c.try_check_salt_len(&Bytes::from_slice(&e, &[0u8; 33])).is_err());
        // Bytes entrypoints enforce the same gate.
        let deployer = Address::generate(&e);
        assert!(c.try_predict_with_salt_bytes(&deployer, &Bytes::from_slice(&e, &[0u8; 4])).is_err());
        assert!(c.try_deploy_with_salt_bytes(&deployer, &Bytes::from_slice(&e, &[0u8; 4]), &vec![&e], &Map::new(&e)).is_err());
    }

    fn one_delegated_signer(e: &Env) -> Vec<Signer> {
        // OZ rules require ≥1 signer or policy per rule; a Delegated signer
        // needs no verifier contract (keeps the unit test hermetic).
        vec![&e, Signer::Delegated(Address::generate(e))]
    }

    #[test]
    fn predict_deploy_parity_for_pid() {
        let e = Env::default();
        // Root-only mock (regression pin for the on-chain
        // Auth.InvalidAction): `deploy_inner` records the deployer auth via
        // `require_auth()` on THIS root invocation, so no non-root mock is
        // needed. Reverting the `require_auth` line makes this test fail
        // exactly like the testnet deploy did.
        e.mock_all_auths();
        let factory = setup(&e);
        let c = PeridotFactoryContractClient::new(&e, &factory);
        let deployer = Address::generate(&e);
        let pid = String::from_str(&e, "ifal@pid");
        let predicted = c.predict_for_pid(&deployer, &pid);
        let signers = one_delegated_signer(&e);
        let deployed = c.deploy(&deployer, &pid, &signers, &Map::new(&e));
        assert_eq!(predicted, deployed);
        // The deployed account is the pinned account shape (genesis rule 0).
        assert_eq!(account::Client::new(&e, &deployed).get_context_rules_count(), 1);
        assert_eq!(account::Client::new(&e, &deployed).get_snapshot_version(), 1);
        // Different pid → different address (AC1.6 on-chain).
        let other = c.predict_for_pid(&deployer, &String::from_str(&e, "bob@pid"));
        assert_ne!(predicted, other);
        // Different deployer → different address.
        let other_deployer = Address::generate(&e);
        assert_ne!(predicted, c.predict_for_pid(&other_deployer, &pid));
    }

    #[test]
    fn deploy_with_explicit_salt_parity() {
        let e = Env::default();
        // Root-only mock here too — same regression pin as above.
        e.mock_all_auths();
        let factory = setup(&e);
        let c = PeridotFactoryContractClient::new(&e, &factory);
        let deployer = Address::generate(&e);
        let salt = c.pid_to_salt(&String::from_str(&e, "carol@pid"));
        assert_eq!(
            c.predict_address(&deployer, &salt),
            c.deploy_with_salt(&deployer, &salt, &one_delegated_signer(&e), &Map::new(&e))
        );
    }
}
