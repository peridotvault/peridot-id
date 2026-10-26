//! Withdraw protocol revenue from the PDA vault (ANT-635 option a, ANT-638).
//!
//! Admin-gated: the signer must be in the live `admins[..count)` window else
//! `NotAdmin`. Never drains below the rent-exempt minimum for a 0-byte
//! program-owned account (withdraw-all-but-rent is the max).
//!
//! Checks-effects-interactions: all verification precedes the lamport move.
//! NO CPI and NO `invoke_signed` (D4) — direct `set_lamports` only, same
//! pattern as `withdraw_sol.rs`. Deny D2 enforced: destination MUST NOT equal
//! treasury/config PDA and MUST NOT be owned by this program.

use crate::{
    errors::PeridotError,
    treasury::{verify_config_pda, verify_treasury_pda, RevenueConfig},
};
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    Address, ProgramResult,
};

use super::InstructionData;

/// Instruction data layout: `amount u64` (LE).
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let treasury = &accounts[0];
    let config = &accounts[1];
    let admin = &accounts[2];
    let destination = &accounts[3];

    if !admin.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    // D2: destination can never be the vault, the config, or any account
    // owned by this program (blocks re-entry into user vaults).
    if destination.address() == treasury.address() || destination.address() == config.address() {
        return Err(PeridotError::InvalidDestination.into());
    }
    if destination.owned_by(program_id) {
        return Err(PeridotError::InvalidDestination.into());
    }

    let amount = data.read_u64_at(0)?;

    // Verify both PDAs derive from seeds + runtime program_id.
    verify_treasury_pda(treasury, program_id)?;
    verify_config_pda(config, program_id)?;

    // Admin gate (least privilege: only listed admins move revenue).
    let admin_key: [u8; 32] = *admin.address().as_array();
    {
        let borrowed = config.try_borrow()?;
        let cfg = RevenueConfig::try_from_bytes(&borrowed)?;
        if !cfg.is_admin(&admin_key) {
            return Err(PeridotError::NotAdmin.into());
        }
    }

    // Rent floor: the 0-byte treasury must stay rent-exempt.
    let floor = Rent::get()?.try_minimum_balance(0)?;
    let available = treasury.lamports().saturating_sub(floor);
    if amount > available {
        return Err(PeridotError::InsufficientFunds.into());
    }

    // Value move: direct lamport mutation only (no CPI, D4).
    let t = *treasury;
    let d = *destination;
    d.set_lamports(d.lamports() + amount);
    t.set_lamports(t.lamports() - amount);

    pinocchio_log::log!("PeridotEvent::RevenueWithdrawn");
    Ok(())
}
