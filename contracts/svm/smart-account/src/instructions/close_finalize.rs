//! Complete teardown after the unclaim grace window (ANT-866 B1, permissionless).
//!
//! Anyone may submit once the chain clock reaches the ticket deadline: the
//! tombstone PDA is created (submitter-funded, permanent — the pid is never
//! reused), the FULL vault balance pays out to the request-bound destination,
//! the vault is deleted, and the ticket rent follows to the destination.
//! The destination cannot be redirected here — it was fixed (owner-signed) at
//! `close_request` time, so permissionless finalization cannot steal.
//!
//! No signature is verified: authorization is the live ticket plus the mature
//! chain clock. Replay is impossible — finalize deletes both the vault and
//! the ticket it consumed.

use crate::{
    errors::PeridotError,
    state::{
        check_close_mature, verify_pda, verify_ticket_pda, verify_tombstone_absent,
        CloseTicket, SmartAccount, TombstoneMut, TOMBSTONE_LEN,
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

/// Accounts:
///   0. `[WRITE, SIGNER]` submitter (any payer: fronts the tombstone rent;
///      receives nothing — the ticket rent follows to the destination)
///   1. `[WRITE]` smart account PDA (must be CLOSING program-owned)
///   2. `[WRITE]` close-ticket PDA (must be live for this vault)
///   3. `[WRITE]` tombstone PDA (must be uninitialized / system-owned)
///   4. `[WRITE]` destination (must equal the ticket destination)
///   5. `[]` system program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    _data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let submitter = &accounts[0];
    let smart_account = &accounts[1];
    let ticket = &accounts[2];
    let tombstone = &accounts[3];
    let destination = &accounts[4];

    if !submitter.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }
    if !ticket.owned_by(program_id) {
        return Err(PeridotError::CloseTicketNotFound.into());
    }

    let (authority, account_id, key_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        if state.status() != crate::state::STATUS_CLOSING {
            return Err(PeridotError::CloseTicketNotFound.into());
        }
        (state.authority(), state.account_id(), state.key_hash())
    };
    verify_pda(smart_account, program_id, account_id, key_hash)?;
    verify_ticket_pda(ticket, program_id, account_id, key_hash)?;
    // Tombstone must be absent (double-finalize would find it initialized).
    let tombstone_bump = verify_tombstone_absent(tombstone, program_id, account_id)?;

    // The ticket must belong to THIS vault, and the payout must equal the
    // request-bound destination exactly (no redirection at finalize time).
    let (deadline, ticket_destination) = {
        let borrowed = ticket.try_borrow()?;
        let record = CloseTicket::try_from_bytes(&borrowed)?;
        if record.account_id() != account_id || record.authority() != authority {
            return Err(PeridotError::CloseTicketNotFound.into());
        }
        (record.deadline(), record.destination())
    };
    if destination.address().as_array() != &ticket_destination {
        return Err(PeridotError::InvalidDestination.into());
    }
    if destination.address() == smart_account.address()
        || destination.address() == ticket.address()
        || destination.address() == tombstone.address()
    {
        return Err(PeridotError::InvalidDestination.into());
    }

    // Grace must have elapsed on the chain clock (fail-closed early).
    let clock = Clock::get()?;
    check_close_mature(deadline, clock.unix_timestamp)?;

    // Tombstone first (submitter-funded, permanent): even if a later step
    // failed, the revert is atomic — but ordering the tombstone before the
    // money movement keeps the audit story linear (tombstone, then payout).
    let tombstone_signer_seeds = [tombstone_bump];
    let tombstone_seeds = [
        pinocchio::cpi::Seed::from(b"peridot_id".as_slice()),
        pinocchio::cpi::Seed::from(b"tombstone".as_slice()),
        pinocchio::cpi::Seed::from(account_id.as_slice()),
        pinocchio::cpi::Seed::from(tombstone_signer_seeds.as_slice()),
    ];
    let tombstone_signer = pinocchio::cpi::Signer::from(&tombstone_seeds[..]);
    create_account_with_minimum_balance_signed(
        tombstone,
        TOMBSTONE_LEN,
        program_id,
        submitter,
        None,
        &[tombstone_signer],
    )?;
    {
        let mut data_ref = tombstone.try_borrow_mut()?;
        let mut record = TombstoneMut::try_from_bytes(&mut data_ref)?;
        record.initialize(account_id, authority, clock.slot);
    }

    // Full vault balance to the bound destination, ticket rent follows.
    let vault_lamports = smart_account.lamports();
    let ticket_lamports = ticket.lamports();
    let to = *destination;
    to.set_lamports(to.lamports() + vault_lamports + ticket_lamports);
    let vault = *smart_account;
    vault.close()?;
    let closed_ticket = *ticket;
    closed_ticket.close()?;

    pinocchio_log::log!("PeridotEvent::AccountClosed");
    Ok(())
}
