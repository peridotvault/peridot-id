//! Initialize the smart account PDA.

use crate::{
    errors::PeridotError,
    state::{verify_pda, SmartAccountMut, STATE_LEN},
    ID,
};
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    Address, ProgramResult,
};
use pinocchio_system::create_account_with_minimum_balance_signed;

use super::InstructionData;

/// Instruction data layout: `account_id [u8; 32] | authority [u8; 32]`.
const ACCOUNT_ID_OFFSET: usize = 0;
const AUTHORITY_OFFSET: usize = 32;

/// Accounts:
///   0. `[WRITE, SIGNER]` rent payer (funds the PDA creation)
///   1. `[WRITE]` smart account PDA (must be uninitialized)
///   2. `[]` system program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let rent_payer = &accounts[0];
    let smart_account = &accounts[1];

    if !rent_payer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    if smart_account.data_len() != 0 {
        return Err(PeridotError::AlreadyInitialized.into());
    }

    let account_id = data.read_array::<32>(ACCOUNT_ID_OFFSET)?;
    let authority = data.read_array::<33>(AUTHORITY_OFFSET)?;
    let bump = verify_pda(smart_account, program_id, account_id)?;

    let signer_seeds = [bump];
    let seeds = [
        Seed::from(b"peridot".as_slice()),
        Seed::from(b"account".as_slice()),
        Seed::from(account_id.as_slice()),
        Seed::from(signer_seeds.as_slice()),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds[..]);

    // Create the PDA (funded by rent_payer, owned by this program, PDA signs via seeds).
    create_account_with_minimum_balance_signed(
        smart_account,
        STATE_LEN,
        &ID,
        rent_payer,
        None,
        &[signer],
    )?;

    // Write the initial state.
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.initialize(account_id, authority);
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AccountInitialized");
    Ok(())
}