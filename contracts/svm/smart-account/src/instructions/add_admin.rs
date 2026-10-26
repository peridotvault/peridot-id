//! Add a revenue-vault admin (ANT-635 option a, ANT-638).
//!
//! Signer must be an existing live admin; `new_admin` must not already be
//! listed; fails `TooManyAdmins` at 8. The zero address is rejected
//! (`InvalidAccountData`, ANT-687 — it could never sign, so it would burn a
//! slot); PDAs must never be added as admins (documented prohibition, same
//! reason — no `invoke_signed` escalation on these paths). In-place mutation,
//! no realloc. Admin keys sign directly (no WebAuthn, no sysvar needed).

use crate::{
    errors::PeridotError,
    treasury::{verify_config_pda, RevenueConfig, RevenueConfigMut},
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout: `new_admin [u8; 32]`.
/// Accounts: 0 = `[WRITE]` config PDA, 1 = `[WRITE, SIGNER]` existing admin.
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let config = &accounts[0];
    let admin = &accounts[1];

    if !admin.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    verify_config_pda(config, program_id)?;

    let new_admin: [u8; 32] = data.read_array::<32>(0)?;

    let mut data_ref = config.try_borrow_mut()?;
    // Read-gate first (existing admin), then mutate.
    {
        let view = RevenueConfig::try_from_bytes(&data_ref)?;
        let signer_key: [u8; 32] = *admin.address().as_array();
        if !view.is_admin(&signer_key) {
            return Err(PeridotError::NotAdmin.into());
        }
    }
    let mut cfg = RevenueConfigMut::try_from_bytes(&mut data_ref)?;
    cfg.add_admin(new_admin)?;
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AdminAdded");
    Ok(())
}
