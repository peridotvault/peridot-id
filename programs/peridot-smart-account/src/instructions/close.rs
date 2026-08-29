//! Close the smart account, returning rent to a destination (authorized by the secp256r1
//! passkey). Not exposed by any V1 API (ADR 004 lifecycle: a DB delete must never close an
//! on-chain account); exists in the program for teardown.

use crate::{
    auth,
    errors::PeridotError,
    state::{verify_nonce, verify_pda, SmartAccount},
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout: `nonce u64 | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const EXPIRY_OFFSET: usize = 8;
const CLIENT_JSON_LEN_OFFSET: usize = 16;

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[WRITE]` destination (receives the rent lamports)
///   2. `[]` instructions sysvar
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let smart_account = &accounts[0];
    let destination = &accounts[1];
    let instructions = &accounts[2];

    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data
        .read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let authority = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        verify_nonce(&state, nonce)?;
        state.authority()
    };
    let account_id = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        state.account_id()
    };
    verify_pda(smart_account, program_id, account_id)?;

    // Bind the destination into the signed payload (no value moves to an unapproved address).
    let destination_bytes: [u8; 32] = *destination.address().as_array();
    let payload = auth::payload_hash(&[
        &nonce.to_le_bytes(),
        &destination_bytes,
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1(instructions, &authority, client_json, &payload)?;

    let lamports = smart_account.lamports();
    let to = *destination;
    to.set_lamports(to.lamports() + lamports);
    let account = *smart_account;
    account.close()?;

    pinocchio_log::log!("PeridotEvent::AccountClosed");
    Ok(())
}