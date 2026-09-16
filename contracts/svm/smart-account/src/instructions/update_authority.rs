//! Rotate the smart account authority, V3 authorization (authorized by the current
//! secp256r1 passkey).
//!
//! The V3 payload binds op-tag ‖ account_id ‖ nonce ‖ new authority ‖ expiry, so a
//! rotation signature for one PID can never rotate a sibling account, even under a
//! shared current key. The zero key is rejected: it could never authorize again and
//! would brick the account. Rotation rewrites key bytes only — the PDA never moves.

use crate::{
    auth,
    errors::PeridotError,
    state::{verify_nonce, verify_pda, SmartAccount, SmartAccountMut, AUTHORITY_LEN},
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | new_authority [u8; 33] | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const NEW_AUTHORITY_OFFSET: usize = 8;
const EXPIRY_OFFSET: usize = 8 + 33;
const CLIENT_JSON_LEN_OFFSET: usize = 8 + 33 + 8;

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[]` instructions sysvar
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let smart_account = &accounts[0];
    let instructions = &accounts[1];

    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let new_authority = data.read_array::<33>(NEW_AUTHORITY_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data
        .read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    if new_authority == [0u8; AUTHORITY_LEN] {
        return Err(PeridotError::Unauthorized.into());
    }

    let (current_authority, account_id, rp_id_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.rp_id_hash()?)
    };
    verify_pda(smart_account, program_id, account_id)?;

    let payload = auth::payload_hash_v3(&[
        &[auth::OP_UPDATE_AUTHORITY],
        &account_id,
        &nonce.to_le_bytes(),
        &new_authority,
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &current_authority, &rp_id_hash, client_json, &payload)?;

    debug_assert_eq!(new_authority.len(), AUTHORITY_LEN);
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.set_authority(new_authority);
    state.increment_nonce();
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AuthorityUpdated");
    Ok(())
}
