//! Initialize the program-bound revenue vault (ANT-635 option a, ANT-638).
//!
//! Creates the config PDA (`[b"config"]`, 264 bytes, v1) and the treasury PDA
//! (`[b"treasury"]`, 0 bytes) via system `create_account` with PDA signer
//! seeds, owner = runtime `program_id`. Writes config v1 with
//! `admins[0] = initial_admin` (= initer signer, ANT-801 H3 binding).
//! First-writer-wins: fails with
//! `ConfigAlreadyInitialized` if either PDA is already program-owned.
//!
//! Deny coverage: touches ONLY config + treasury PDAs (+ system program).
//! NEVER user PDA state, session PDAs, or BACKEND (D1/D3). No WebAuthn, no
//! auth payload — ANT-801 (H3): `initial_admin` MUST equal the initer signer.
//! The initer funds rent AND becomes `admins[0]` atomically; anyone winning
//! the deploy->init race would otherwise appoint themselves via
//! `withdraw_revenue.rs` and drain fees. Production must init atomically in
//! the deploy flow with the same operator keypair (Trevor owns script
//! atomicity).

use crate::errors::PeridotError;
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use crate::treasury::{RevenueConfigMut, CONFIG_LEN};
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
use pinocchio_system::create_account_with_minimum_balance_signed;
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout: `initial_admin [u8; 32]` (no auth payload).
/// ANT-801 (H3, Access control): `initial_admin` MUST equal `accounts[0]`
/// (the initer signer) — genesis appoints self only, `Unauthorized` otherwise.
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let initer = &accounts[0];
    let config = &accounts[1];
    let treasury = &accounts[2];
    // accounts[3] = system program (used implicitly by the create CPI).

    if !initer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    // First-writer-wins: either PDA already program-owned/initialized rejects.
    if config.owned_by(program_id) || treasury.owned_by(program_id) {
        return Err(PeridotError::ConfigAlreadyInitialized.into());
    }
    if config.data_len() != 0 || treasury.data_len() != 0 {
        return Err(PeridotError::ConfigAlreadyInitialized.into());
    }

    let initial_admin: [u8; 32] = data.read_array::<32>(0)?;
    // H3 binding (checks-effects-interactions: before any create_account CPI;
    // Gas optimization: single 32-byte compare, no extra syscalls):
    // the signer that funds rent IS the genesis admin — no delegated appoint.
    if initial_admin != *initer.address().as_array() {
        return Err(PeridotError::Unauthorized.into());
    }

    // Verify derivations against the runtime program_id (no split-brain).
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected_config, config_bump) =
            pinocchio::Address::find_program_address(&[crate::treasury::CONFIG_SEED], program_id);
        let (expected_treasury, treasury_bump) =
            pinocchio::Address::find_program_address(&[crate::treasury::TREASURY_SEED], program_id);
        if config.address() != &expected_config || treasury.address() != &expected_treasury {
            return Err(PeridotError::InvalidPda.into());
        }
        // Create both PDAs (initer funds rent-exempt minimums). The
        // minimum-balance helper also absorbs pre-funded system-owned stubs
        // (e.g. an airdrop/transfer that landed before init): it tops-up to
        // rent instead of failing with "already in use".
        let cb = [config_bump];
        let c_seeds = [
            pinocchio::cpi::Seed::from(crate::treasury::CONFIG_SEED),
            pinocchio::cpi::Seed::from(cb.as_slice()),
        ];
        let c_signer = pinocchio::cpi::Signer::from(&c_seeds[..]);
        pinocchio_system::create_account_with_minimum_balance_signed(
            config,
            CONFIG_LEN,
            program_id,
            initer,
            None,
            &[c_signer],
        )?;

        let tb = [treasury_bump];
        let t_seeds = [
            pinocchio::cpi::Seed::from(crate::treasury::TREASURY_SEED),
            pinocchio::cpi::Seed::from(tb.as_slice()),
        ];
        let t_signer = pinocchio::cpi::Signer::from(&t_seeds[..]);
        pinocchio_system::create_account_with_minimum_balance_signed(
            treasury,
            0,
            program_id,
            initer,
            None,
            &[t_signer],
        )?;

        let mut data_ref = config.try_borrow_mut()?;
        let mut cfg = RevenueConfigMut::try_from_bytes(&mut data_ref)?;
        cfg.initialize(initial_admin, treasury_bump, config_bump);
        drop(data_ref);
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        // Host stub: derivation syscalls unavailable; the on-chain integration
        // suite exercises the real path. Still enforce account-shape guards.
        let _ = (config, treasury, initial_admin);
    }

    pinocchio_log::log!("PeridotEvent::TreasuryInitialized");
    Ok(())
}
