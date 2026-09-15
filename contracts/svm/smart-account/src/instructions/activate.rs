//! Activate a user's smart account (Peridot-sponsored activation with reimbursement).
//!
//! The user deposits SOL directly to their deterministic (uninitialized) PDA address. When
//! the backend detects sufficient funds it runs activation: a Peridot relayer signs the
//! tx and an optional top-up brings the PDA to rent-exempt, then this instruction claims
//! the account and moves the activation fee into a Peridot treasury — all in one atomic
//! transaction. No temporary wallet is created; the user's deposited balance stays on the
//! one PDA address.
//!
//! The claim itself is passkey-signed: the payload binds
//! `account_id ‖ authority ‖ activation_fee ‖ expiry ‖ treasury`, so a stranger can
//! neither squat the PDA nor divert the fee — only the new authority's key authorizes.
//!
//! Handles both cases:
//!   * account is empty  → `create_account_with_minimum_balance_signed` creates it (payer funds rent)
//!   * account is funded → the same helper tops-up to rent (if needed) then assigns + resizes,
//!     so a raw System transfer to the uninitialized address is consumed safely.

use crate::{
    auth,
    config::BACKEND,
    errors::PeridotError,
    state::{verify_pda, SmartAccountMut, STATE_LEN},
    ID,
};
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::create_account_with_minimum_balance_signed;

use super::InstructionData;

/// Instruction data layout:
/// `account_id [u8; 32] | authority [u8; 33] | activation_fee u64 | expiry i64 | client_json_len u16 | clientDataJSON`.
const ACCOUNT_ID_OFFSET: usize = 0;
const AUTHORITY_OFFSET: usize = 32;
const ACTIVATION_FEE_OFFSET: usize = 65;
const EXPIRY_OFFSET: usize = 73;
const CLIENT_JSON_LEN_OFFSET: usize = 81;

/// Accounts:
///   0. `[WRITE, SIGNER]` relayer (Peridot treasury float; pays the network fee / rent)
///   1. `[WRITE]` smart account PDA (must be uninitialized / system-owned)
///   2. `[WRITE]` treasury account (receives the activation fee)
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

    let relayer = &accounts[0];
    let smart_account = &accounts[1];
    let treasury = &accounts[2];
    let instructions = &accounts[4];

    if !relayer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    // PID-ownership proof (see initialize): only the backend may claim PDAs, so a
    // stranger can neither squat a funded deposit nor divert it to own treasury.
    if relayer.address().as_array() != &BACKEND {
        return Err(PeridotError::Forbidden.into());
    }
    // The PDA may not already be program-owned or initialized.
    if smart_account.data_len() != 0 || smart_account.owned_by(program_id) {
        return Err(PeridotError::AlreadyInitialized.into());
    }
    if treasury.address() == smart_account.address() {
        return Err(PeridotError::InvalidDestination.into());
    }

    let account_id = data.read_array::<32>(ACCOUNT_ID_OFFSET)?;
    let authority = data.read_array::<33>(AUTHORITY_OFFSET)?;
    let activation_fee = data.read_u64_at(ACTIVATION_FEE_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let bump = verify_pda(smart_account, program_id, account_id)?;

    // Only the new authority authorizes the claim, the fee, and the recipient.
    let treasury_bytes: [u8; 32] = *treasury.address().as_array();
    let payload = auth::payload_hash(&[
        &account_id,
        &authority,
        &activation_fee.to_le_bytes(),
        &expiry.to_le_bytes(),
        &treasury_bytes,
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1(instructions, &authority, client_json, &payload)?;

    let signer_seeds = [bump];
    let seeds = [
        pinocchio::cpi::Seed::from(b"peridot_id".as_slice()),
        pinocchio::cpi::Seed::from(b"account".as_slice()),
        pinocchio::cpi::Seed::from(account_id.as_slice()),
        pinocchio::cpi::Seed::from(signer_seeds.as_slice()),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds[..]);

    // Claim the account: create (if empty) or top-up→assign→allocate (if pre-funded).
    // Payer = relayer. Rent is paid only up to the rent-exempt amount for the state.
    create_account_with_minimum_balance_signed(
        smart_account,
        STATE_LEN,
        &ID,
        relayer,
        None,
        &[signer.clone()],
    )?;

    // Rent floor: after claiming, the account must keep at least the rent-exempt amount.
    let rent = Rent::get()?.try_minimum_balance(STATE_LEN)?;
    if smart_account.lamports() < rent + activation_fee {
        return Err(PeridotError::InsufficientFunds.into());
    }

    // Reimburse the activation fee from the smart account to the treasury (PDA-signed).
    //
    // Move lamports directly, exactly like withdraw_sol — a System `Transfer` is forbidden
    // when `from` carries data, and this PDA now holds 80 bytes of program-owned state.
    let from = *smart_account;
    let to = *treasury;
    to.set_lamports(to.lamports() + activation_fee);
    from.set_lamports(from.lamports() - activation_fee);

    // Write the initial state (authority = the user's passkey).
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.initialize(account_id, authority);
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AccountActivated");
    Ok(())
}