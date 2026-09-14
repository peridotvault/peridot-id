//! Sponsored SPL-token withdrawal (authorized by a secp256r1 passkey, ADR 005 B).
//!
//! Peridot's relayer signs the transaction and floats the network fee; the smart account
//! reimburses `relay_fee` (fee × (1 + margin)) to the Peridot treasury in the same
//! transaction. The token transfer runs through the SPL Token program CPI; the relay fee
//! is moved as SOL by direct lamports mutation (the PDA carries program data).

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
/// `nonce u64 | amount u64 | destination_ata [u8; 32] | expiry i64 | relay_fee u64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const AMOUNT_OFFSET: usize = 8;
const DESTINATION_ATA_OFFSET: usize = 16;
const EXPIRY_OFFSET: usize = 48;
const RELAY_FEE_OFFSET: usize = 56;
const CLIENT_JSON_LEN_OFFSET: usize = 64;

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[WRITE]` source ATA (owner = smart account PDA)
///   2. `[]` mint
///   3. `[WRITE]` destination ATA
///   4. `[]` token program
///   5. `[]` instructions sysvar
///   6. `[WRITE]` treasury (receives the reimbursed relay fee)
///   7. `[WRITE, SIGNER]` relayer (pays the network fee)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let smart_account = &accounts[0];
    let source_ata = &accounts[1];
    let destination_ata = &accounts[3];
    let instructions = &accounts[5];
    let treasury = &accounts[6];
    let relayer = &accounts[7];

    if !relayer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }
    if treasury.address() == smart_account.address() {
        return Err(PeridotError::InvalidDestination.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let amount = data.read_u64_at(AMOUNT_OFFSET)?;
    let destination_ata_bytes = data.read_array::<32>(DESTINATION_ATA_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let relay_fee = data.read_u64_at(RELAY_FEE_OFFSET)?;
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
        &relay_fee.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1(instructions, &authority, client_json, &payload)?;

    if smart_account.lamports() < relay_fee {
        return Err(PeridotError::InsufficientFunds.into());
    }

    let signer_seeds = [bump];
    let seeds = [
        Seed::from(b"peridot_id".as_slice()),
        Seed::from(b"account".as_slice()),
        Seed::from(account_id.as_slice()),
        Seed::from(signer_seeds.as_slice()),
    ];
    let signer = Signer::from(&seeds[..]);

    // Transfer the token amount and reimburse the relay fee (SOL) to the treasury.
    let transfer = TokenTransfer {
        from: source_ata,
        to: destination_ata,
        authority: smart_account,
        amount,
    };
    transfer.invoke_signed(&[signer.clone()])?;

    let from = *smart_account;
    let t = *treasury;
    t.set_lamports(t.lamports() + relay_fee);
    from.set_lamports(from.lamports() - relay_fee);

    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.increment_nonce();
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::TransactionExecuted");
    Ok(())
}