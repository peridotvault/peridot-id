//! Withdraw SPL tokens from the smart account (authorized by a secp256r1 passkey, ADR 005 B).

use crate::{
    auth,
    errors::PeridotError,
    state::{verify_nonce, verify_pda, SmartAccount, SmartAccountMut},
};
use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    Address, ProgramResult,
};
use pinocchio_token::instructions::Transfer as TokenTransfer;

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | amount u64 | destination_ata [u8; 32] | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const AMOUNT_OFFSET: usize = 8;
const DESTINATION_ATA_OFFSET: usize = 16;
const EXPIRY_OFFSET: usize = 48;
const CLIENT_JSON_LEN_OFFSET: usize = 56;

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[WRITE]` source ATA (owner = smart account PDA)
///   2. `[]` mint
///   3. `[WRITE]` destination ATA
///   4. `[]` token program
///   5. `[]` instructions sysvar
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let smart_account = &accounts[0];
    let source_ata = &accounts[1];
    let destination_ata = &accounts[3];
    let instructions = &accounts[5];

    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let amount = data.read_u64_at(AMOUNT_OFFSET)?;
    let destination_ata_bytes = data.read_array::<32>(DESTINATION_ATA_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data
        .read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let destination_ata_addr = Address::new_from_array(destination_ata_bytes);
    if destination_ata.address() != &destination_ata_addr {
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
    let bump = verify_pda(smart_account, program_id, account_id)?;

    let payload = auth::payload_hash(&[
        &nonce.to_le_bytes(),
        &amount.to_le_bytes(),
        &destination_ata_bytes,
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1(instructions, &authority, client_json, &payload)?;

    let signer_seeds = [bump];
    let seeds = [
        Seed::from(b"peridot".as_slice()),
        Seed::from(b"account".as_slice()),
        Seed::from(account_id.as_slice()),
        Seed::from(signer_seeds.as_slice()),
    ];
    let signer = Signer::from(&seeds[..]);

    let transfer = TokenTransfer {
        from: source_ata,
        to: destination_ata,
        authority: smart_account,
        amount,
    };
    transfer.invoke_signed(&[signer])?;

    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.increment_nonce();
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::TransactionExecuted");
    Ok(())
}