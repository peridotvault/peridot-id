//! Revive a vault inside its unclaim grace window (ANT-866 B1, owner-signed).
//!
//! The owner cancels an accidental (or no-longer-wanted) close: the ticket
//! rent is refunded INTO the vault, the ticket is deleted, the vault returns
//! to ACTIVE, and the owner nonce is consumed. Allowed any time before
//! `close_finalize` lands — even past the deadline, as long as nobody
//! finalized first.

use crate::{
    auth,
    errors::PeridotError,
    state::{
        verify_nonce, verify_pda, verify_ticket_pda, CloseTicket, SmartAccount,
        SmartAccountMut, STATUS_ACTIVE,
    },
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const EXPIRY_OFFSET: usize = 8;
const CLIENT_JSON_LEN_OFFSET: usize = 16;

/// Accounts:
///   0. `[WRITE]` smart account PDA (must be CLOSING program-owned)
///   1. `[WRITE]` close-ticket PDA (must be live for this vault)
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
    let ticket = &accounts[1];
    let instructions = &accounts[2];

    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }
    if !ticket.owned_by(program_id) {
        return Err(PeridotError::CloseTicketNotFound.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let (authority, account_id, key_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        if state.status() != crate::state::STATUS_CLOSING {
            return Err(PeridotError::CloseTicketNotFound.into());
        }
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.key_hash())
    };
    verify_pda(smart_account, program_id, account_id, key_hash)?;
    verify_ticket_pda(ticket, program_id, account_id, key_hash)?;

    // The ticket must belong to THIS vault (same pid, same claiming key).
    {
        let borrowed = ticket.try_borrow()?;
        let record = CloseTicket::try_from_bytes(&borrowed)?;
        if record.account_id() != account_id || record.authority() != authority {
            return Err(PeridotError::CloseTicketNotFound.into());
        }
    }

    let payload = auth::payload_hash_v3(&[
        &[auth::OP_CLOSE_CANCEL],
        &account_id,
        &nonce.to_le_bytes(),
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, client_json, &payload)?;

    // Effects first (checks-effects-interactions): revive + burn the nonce
    // BEFORE any lamport movement. Failures revert atomically.
    {
        let mut data_ref = smart_account.try_borrow_mut()?;
        let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
        state.increment_nonce();
        state.set_status(STATUS_ACTIVE);
    }

    // Ticket rent refunds into the vault (no submitter account is needed —
    // the request front is absorbed as the cost of opening grace).
    let lamports = ticket.lamports();
    let to = *smart_account;
    to.set_lamports(to.lamports() + lamports);
    let account = *ticket;
    account.close()?;

    pinocchio_log::log!("PeridotEvent::CloseCancelled");
    Ok(())
}
