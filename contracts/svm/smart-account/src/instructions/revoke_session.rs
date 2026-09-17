//! Revoke a gameplay session, owner authorization (secp256r1 passkey).
//!
//! Immediate and state-based: flips `revoked` on the session record, consuming
//! the vault's owner nonce. Needs no session cooperation — a stolen session key
//! dies the moment this lands.

use crate::{
    auth,
    errors::PeridotError,
    state::{verify_nonce, verify_pda, verify_session_pda, SessionAccount, SessionAccountMut, SmartAccount},
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | session_pubkey [u8; 32] | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const SESSION_KEY_OFFSET: usize = 8;
const EXPIRY_OFFSET: usize = 40;
const CLIENT_JSON_LEN_OFFSET: usize = 48;

/// Accounts:
///   0. `[WRITE]` vault PDA (owner authority + nonce live here; nonce consumed)
///   1. `[WRITE]` session PDA (record to revoke)
///   2. `[]` instructions sysvar (secp256r1 introspection)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let vault = &accounts[0];
    let session = &accounts[1];
    let instructions = &accounts[2];

    if !vault.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if !session.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let session_key = data.read_array::<32>(SESSION_KEY_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let (authority, account_id, rp_id_hash) = {
        let borrowed = vault.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.rp_id_hash()?)
    };
    verify_pda(vault, program_id, account_id)?;
    verify_session_pda(session, program_id, account_id, session_key)?;

    {
        let borrowed = session.try_borrow()?;
        let record = SessionAccount::try_from_bytes(&borrowed)?;
        if record.session_key() != session_key || record.account_id() != account_id {
            return Err(PeridotError::SessionNotFound.into());
        }
        if !record.is_active() {
            return Err(PeridotError::SessionRevoked.into());
        }
    }

    let payload = auth::payload_hash_session(&[
        &[auth::OP_REVOKE_SESSION],
        &account_id,
        &session_key,
        &nonce.to_le_bytes(),
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, &rp_id_hash, client_json, &payload)?;

    {
        let mut data_ref = session.try_borrow_mut()?;
        let mut record = SessionAccountMut::try_from_bytes(&mut data_ref)?;
        record.revoke();
    }
    {
        let mut data_ref = vault.try_borrow_mut()?;
        let mut state = crate::state::SmartAccountMut::try_from_bytes(&mut data_ref)?;
        state.increment_nonce();
    }

    pinocchio_log::log!("PeridotEvent::SessionRevoked");
    Ok(())
}
