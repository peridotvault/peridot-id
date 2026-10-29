//! Open the unclaim grace window for a vault (ANT-866 B1, owner-signed).
//!
//! The owner authorizes teardown to a caller-chosen destination; the vault
//! flips to `STATUS_CLOSING` (every spend/rotate/session operation fails
//! `AccountClosing` from here on), a close ticket is created (submitter-
//! funded, like activation rent), and the owner nonce is consumed. Funds do
//! NOT move here — `close_finalize` pays out after `CLOSE_GRACE_SECS`, and
//! `close_cancel` revives the vault any time before finalization.
//!
//! The V3 payload binds op-tag ‖ account_id ‖ nonce ‖ destination ‖ expiry,
//! so a request signature for one PID can never open grace on a sibling
//! account, and the payout destination is fixed at request time (finalize
//! cannot redirect it).

use crate::{
    auth,
    errors::PeridotError,
    state::{
        verify_nonce, verify_pda, verify_ticket_pda, CloseTicketMut, SmartAccount,
        SmartAccountMut, CLOSE_GRACE_SECS, TICKET_LEN,
    },
};
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::create_account_with_minimum_balance_signed;

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | destination [u8; 32] | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const DESTINATION_OFFSET: usize = 8;
const EXPIRY_OFFSET: usize = 40;
const CLIENT_JSON_LEN_OFFSET: usize = 48;

/// Accounts:
///   0. `[WRITE, SIGNER]` submitter (any payer: fronts the ticket rent;
///      permissionless like activation — the passkey below authorizes)
///   1. `[WRITE]` smart account PDA (must be ACTIVE program-owned)
///   2. `[WRITE]` close-ticket PDA (must be uninitialized / system-owned)
///   3. `[]` system program
///   4. `[]` instructions sysvar (for secp256r1 introspection)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let submitter = &accounts[0];
    let smart_account = &accounts[1];
    let ticket = &accounts[2];
    let instructions = &accounts[4];

    if !submitter.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }
    // Fresh ticket only: one live grace per (account_id, authority).
    if ticket.data_len() != 0 || ticket.owned_by(program_id) {
        return Err(PeridotError::CloseAlreadyRequested.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let destination: [u8; 32] = data.read_array::<32>(DESTINATION_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let (authority, account_id, key_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        state.require_active()?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.key_hash())
    };
    verify_pda(smart_account, program_id, account_id, key_hash)?;
    let bump = verify_ticket_pda(ticket, program_id, account_id, key_hash)?;

    if destination == *smart_account.address().as_array()
        || destination == *ticket.address().as_array()
    {
        return Err(PeridotError::InvalidDestination.into());
    }

    // Destination is fixed at request time: finalize cannot redirect it.
    let payload = auth::payload_hash_v3(&[
        &[auth::OP_CLOSE_REQUEST],
        &account_id,
        &nonce.to_le_bytes(),
        &destination,
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, client_json, &payload)?;

    // Effects first (checks-effects-interactions): freeze the vault + consume
    // the nonce BEFORE the ticket CPI. A failure below reverts atomically.
    // (No recheck under the lock is needed: nothing between the read above
    // and this write can mutate the vault — the only CPI below targets the
    // System program, which cannot call back into this program.)
    let deadline = Clock::get()?.unix_timestamp.saturating_add(CLOSE_GRACE_SECS);
    {
        let mut data_ref = smart_account.try_borrow_mut()?;
        let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
        state.increment_nonce();
        state.set_status(crate::state::STATUS_CLOSING);
    }

    // Ticket rent is fronted by the submitter (never carved from the vault —
    // a dust vault can still enter grace).
    let signer_seeds = [bump];
    let seeds = [
        pinocchio::cpi::Seed::from(b"peridot_id".as_slice()),
        pinocchio::cpi::Seed::from(b"close".as_slice()),
        pinocchio::cpi::Seed::from(account_id.as_slice()),
        pinocchio::cpi::Seed::from(key_hash.as_slice()),
        pinocchio::cpi::Seed::from(signer_seeds.as_slice()),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds[..]);
    create_account_with_minimum_balance_signed(
        ticket,
        TICKET_LEN,
        program_id,
        submitter,
        None,
        &[signer],
    )?;

    {
        let mut data_ref = ticket.try_borrow_mut()?;
        let mut state = CloseTicketMut::try_from_bytes(&mut data_ref)?;
        state.initialize(account_id, authority, destination, deadline, bump);
    }

    pinocchio_log::log!("PeridotEvent::CloseRequested");
    Ok(())
}
