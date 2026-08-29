//! Withdraw SOL from the smart account (authorized by a secp256r1 passkey, ADR 005 B).
//!
//! The passkey signs the domain-separated authorization payload (nonce ‖ amount ‖
//! destination ‖ expiry); the SDK places the Secp256r1 precompile instruction immediately
//! after this one and this processor verifies it via the Instructions sysvar (auth.rs).
//!
//! Lamports are moved directly (no System Program CPI — a System transfer is forbidden
//! when `from` carries data, and the smart account PDA holds SOL + its state).

use crate::{
    auth,
    errors::PeridotError,
    state::{verify_nonce, verify_pda, SmartAccount, SmartAccountMut},
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | amount u64 | destination [u8; 32] | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const AMOUNT_OFFSET: usize = 8;
const DESTINATION_OFFSET: usize = 16;
const EXPIRY_OFFSET: usize = 48;
const CLIENT_JSON_LEN_OFFSET: usize = 56;

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[WRITE]` destination (receives the SOL)
///   2. `[]` instructions sysvar (for secp256r1 introspection)
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
    let amount = data.read_u64_at(AMOUNT_OFFSET)?;
    let destination_bytes = data.read_array::<32>(DESTINATION_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data
        .read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let destination_addr = Address::new_from_array(destination_bytes);
    if destination.address() != &destination_addr {
        return Err(PeridotError::InvalidDestination.into());
    }
    if destination.address() == smart_account.address() {
        return Err(PeridotError::InvalidDestination.into());
    }

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

    let payload = auth::payload_hash(&[
        &nonce.to_le_bytes(),
        &amount.to_le_bytes(),
        &destination_bytes,
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1(instructions, &authority, client_json, &payload)?;

    if smart_account.lamports() < amount {
        return Err(PeridotError::InsufficientFunds.into());
    }

    // Move lamports directly from the PDA to the destination.
    let from = *smart_account;
    let to = *destination;
    to.set_lamports(to.lamports() + amount);
    from.set_lamports(from.lamports() - amount);

    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.increment_nonce();
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::TransactionExecuted");
    Ok(())
}