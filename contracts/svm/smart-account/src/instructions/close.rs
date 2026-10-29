//! Close the smart account immediately, V3 authorization (historical direct path).
//!
//! PERMANENTLY DISABLED (ANT-866 B1): immediate close skips the unclaim grace
//! window and writes no tombstone, so a squatted pre-fund could be drained and
//! the pid re-claimed by a second attacker (ANT-860 PoC-A, proven). Every
//! build rejects it with `CloseDeprecated` before any other validation.
//! Teardown must route through the two-phase flow: `close_request` (grace
//! opens, funds freeze) → `close_cancel` (revive) or `close_finalize`
//! (payout + permanent tombstone). The code below the gate is retained for
//! shape/decoder stability only (discriminant 4 still decodes, then rejects
//! — never shifted).
//!
//! Historical note: the V3 payload bound op-tag ‖ account_id ‖ nonce ‖
//! destination ‖ expiry. That property now lives in `close_request` (which
//! additionally binds the flow to a ticket PDA and a grace deadline).

use crate::{auth, errors::PeridotError, state::verify_pda};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout: `nonce u64 | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const EXPIRY_OFFSET: usize = 8;
const CLIENT_JSON_LEN_OFFSET: usize = 16;

/// ANT-866 B1: the immediate-close path can never delete an account where the
/// grace flow (and its tombstone) is due. Runs before any other validation;
/// unreachable code below is retained for shape stability.
/// A `const` cannot be flipped at runtime by a caller — there is no new
/// signer, money path, or trust root (see ANT-19 gate-flip analysis).
pub const DEPRECATE_DIRECT_CLOSE: bool = true;

/// Reject immediate close on all builds. Pure (no account
/// access), so it is host-testable.
pub fn check_close_allowed() -> ProgramResult {
    if DEPRECATE_DIRECT_CLOSE {
        return Err(PeridotError::CloseDeprecated.into());
    }
    Ok(())
}

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[WRITE]` destination (receives the rent lamports; must differ from the PDA)
///   2. `[]` instructions sysvar
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // ANT-866 B1: immediate close would skip grace + tombstone. Runs before
    // any other validation; unreachable code below is retained for shape stability.
    check_close_allowed()?;

    let smart_account = &accounts[0];
    let destination = &accounts[1];
    let instructions = &accounts[2];

    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }
    if destination.address() == smart_account.address() {
        return Err(PeridotError::InvalidDestination.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data
        .read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let (authority, account_id, key_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = crate::state::SmartAccount::try_from_bytes(&borrowed)?;
        crate::state::verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.key_hash())
    };
    verify_pda(smart_account, program_id, account_id, key_hash)?;

    // Bind the destination into the signed payload (no value moves to an unapproved address).
    let destination_bytes: [u8; 32] = *destination.address().as_array();
    let payload = auth::payload_hash_v3(&[
        &[auth::OP_CLOSE],
        &account_id,
        &nonce.to_le_bytes(),
        &destination_bytes,
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, client_json, &payload)?;

    let lamports = smart_account.lamports();
    let to = *destination;
    to.set_lamports(to.lamports() + lamports);
    let account = *smart_account;
    account.close()?;

    pinocchio_log::log!("PeridotEvent::AccountClosed");
    // Unreachable on every build (gated above): retained so the success event
    // shape is unchanged for indexers if the path is ever re-enabled by spec.
    pinocchio_log::log!("PeridotEvent::AccountCloseDeprecated");
    Ok(())
}
