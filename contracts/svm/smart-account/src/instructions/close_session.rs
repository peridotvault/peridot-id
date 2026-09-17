//! Close a session record and reclaim its rent, owner authorization (passkey).
//!
//! Only revoked or expired sessions can be closed — an active session's rent
//! cannot be yanked (fail-closed against owner-foot-gun closes racing live
//! gameplay). Rent goes to an owner-bound destination.

use crate::{
    auth,
    errors::PeridotError,
    state::{verify_nonce, verify_pda, verify_session_pda, SessionAccount, SmartAccount},
};
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | session_pubkey [u8; 32] | expiry i64 | client_json_len u16 | clientDataJSON`.
/// The rent destination is the passed account (bound in the signed payload).
const NONCE_OFFSET: usize = 0;
const SESSION_KEY_OFFSET: usize = 8;
const EXPIRY_OFFSET: usize = 40;
const CLIENT_JSON_LEN_OFFSET: usize = 48;

/// Accounts:
///   0. `[WRITE]` vault PDA (owner authority + nonce live here; nonce consumed)
///   1. `[WRITE]` session PDA (revoked or expired; rent reclaimed, account closed)
///   2. `[WRITE]` destination (receives rent; must differ from the session PDA)
///   3. `[]` instructions sysvar (secp256r1 introspection)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let vault = &accounts[0];
    let session = &accounts[1];
    let destination = &accounts[2];
    let instructions = &accounts[3];

    if !vault.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if !session.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if destination.address() == session.address() {
        return Err(PeridotError::InvalidDestination.into());
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

    // Only dead sessions close: revoked, or hard-expired on the chain clock.
    {
        let borrowed = session.try_borrow()?;
        let record = SessionAccount::try_from_bytes(&borrowed)?;
        if record.session_key() != session_key || record.account_id() != account_id {
            return Err(PeridotError::SessionNotFound.into());
        }
        if record.is_active() {
            let now = Clock::get()?.unix_timestamp;
            if now <= record.expires_at() {
                return Err(PeridotError::SessionScopeViolation.into());
            }
        }
    }

    // Destination is bound in the payload (rent moves only where approved).
    let destination_bytes: [u8; 32] = *destination.address().as_array();
    let payload = auth::payload_hash_session(&[
        &[auth::OP_CLOSE_SESSION],
        &account_id,
        &session_key,
        &destination_bytes,
        &nonce.to_le_bytes(),
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, &rp_id_hash, client_json, &payload)?;

    let lamports = session.lamports();
    let to = *destination;
    to.set_lamports(to.lamports() + lamports);
    let account = *session;
    account.close()?;
    {
        let mut data_ref = vault.try_borrow_mut()?;
        let mut state = crate::state::SmartAccountMut::try_from_bytes(&mut data_ref)?;
        state.increment_nonce();
    }

    pinocchio_log::log!("PeridotEvent::SessionClosed");
    Ok(())
}
