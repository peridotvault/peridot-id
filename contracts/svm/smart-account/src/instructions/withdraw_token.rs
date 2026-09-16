//! Sponsored SPL-token withdrawal, V3 authorization (authorized by a secp256r1 passkey).
//!
//! Peridot's relayer signs the transaction and floats the network fee; the smart account
//! reimburses the attested `network_fee` in full to the relayer plus `protocol_fee`
//! (recomputed on-chain from the signed fee-policy version) to the canonical revenue
//! vault. The token transfer runs through the SPL Token program CPI; the reimbursement is
//! moved as SOL by direct lamports mutation (the PDA carries program data).
//!
//! The V3 payload binds op-tag ‖ account_id ‖ … (no fee amounts — network costs float
//! with gas by design), so a signature for one PID can never authorize a sibling
//! account. The program explicitly verifies the source token account is owned by the
//! PDA for the expected mint (in addition to the payload binding) rather than relying
//! solely on the Token CPI to fail.

use crate::{
    auth,
    config::TREASURY,
    errors::PeridotError,
    fee::{policy_protocol_bps, split_attested_fee, total_fee},
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
/// `nonce u64 | amount u64 | destination_ata [u8; 32] | expiry i64 | policy u16 | network_fee u64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const AMOUNT_OFFSET: usize = 8;
const DESTINATION_ATA_OFFSET: usize = 16;
const EXPIRY_OFFSET: usize = 48;
const POLICY_OFFSET: usize = 56;
const NETWORK_FEE_OFFSET: usize = 58;
const CLIENT_JSON_LEN_OFFSET: usize = 66;

/// SPL Token Account layout prefixes we verify explicitly:
/// `mint [u8; 32] | owner [u8; 32] | amount u64 | …` (165 bytes total).
const TOKEN_MINT_OFFSET: usize = 0;
const TOKEN_OWNER_OFFSET: usize = 32;
const TOKEN_ACCOUNT_MIN_LEN: usize = 72;

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[WRITE]` source ATA (must be owned by the PDA for `mint`)
///   2. `[]` mint
///   3. `[WRITE]` destination ATA (must be for `mint`)
///   4. `[]` token program
///   5. `[]` instructions sysvar
///   6. `[WRITE]` canonical revenue vault (receives the protocol fee; must equal `config::TREASURY`)
///   7. `[WRITE, SIGNER]` relayer (pays the network fee; receives the exact reimbursement)
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
    let mint = &accounts[2];
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
    if treasury.address().as_array() != &TREASURY {
        return Err(PeridotError::InvalidDestination.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let amount = data.read_u64_at(AMOUNT_OFFSET)?;
    let destination_ata_bytes = data.read_array::<32>(DESTINATION_ATA_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let policy_version = data.read_u16_at(POLICY_OFFSET)?;
    let network_fee = data.read_u64_at(NETWORK_FEE_OFFSET)?;
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data
        .read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let destination_ata_addr = Address::new_from_array(destination_ata_bytes);
    if destination_ata.address() != &destination_ata_addr {
        return Err(PeridotError::InvalidDestination.into());
    }

    // Explicit token-account checks (not just emergent CPI failure): the source
    // must be a token account owned by the PDA for this mint, and the destination
    // must be a token account for this mint.
    {
        let borrowed = source_ata.try_borrow()?;
        if borrowed.len() < TOKEN_ACCOUNT_MIN_LEN {
            return Err(PeridotError::InvalidDestination.into());
        }
        if borrowed[TOKEN_MINT_OFFSET..TOKEN_MINT_OFFSET + 32] != mint.address().as_array()[..] {
            return Err(PeridotError::InvalidDestination.into());
        }
        if borrowed[TOKEN_OWNER_OFFSET..TOKEN_OWNER_OFFSET + 32] != smart_account.address().as_array()[..] {
            return Err(PeridotError::InvalidDestination.into());
        }
    }
    {
        let borrowed = destination_ata.try_borrow()?;
        if borrowed.len() < TOKEN_ACCOUNT_MIN_LEN {
            return Err(PeridotError::InvalidDestination.into());
        }
        if borrowed[TOKEN_MINT_OFFSET..TOKEN_MINT_OFFSET + 32] != mint.address().as_array()[..] {
            return Err(PeridotError::InvalidDestination.into());
        }
    }

    let (authority, account_id, rp_id_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.rp_id_hash()?)
    };
    let bump = verify_pda(smart_account, program_id, account_id)?;

    let bps = policy_protocol_bps(policy_version)?;
    let payload = auth::payload_hash_v3(&[
        &[auth::OP_WITHDRAW_TOKEN],
        &account_id,
        &nonce.to_le_bytes(),
        &amount.to_le_bytes(),
        &destination_ata_bytes,
        &expiry.to_le_bytes(),
        &policy_version.to_le_bytes(),
        &source_ata.address().as_array()[..],
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, &rp_id_hash, client_json, &payload)?;

    let (relayer_fee, protocol_fee) = split_attested_fee(network_fee, bps);
    let total = total_fee(relayer_fee, protocol_fee);
    if smart_account.lamports() < total || total < network_fee {
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

    // Transfer the token amount; reimburse exact network cost to the relayer
    // and the protocol fee to the canonical revenue vault.
    let transfer = TokenTransfer {
        from: source_ata,
        to: destination_ata,
        authority: smart_account,
        amount,
    };
    transfer.invoke_signed(&[signer.clone()])?;

    let from = *smart_account;
    let t = *treasury;
    let r = *relayer;
    r.set_lamports(r.lamports() + relayer_fee);
    t.set_lamports(t.lamports() + protocol_fee);
    from.set_lamports(from.lamports() - total);

    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.increment_nonce();
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::TransactionExecuted");
    Ok(())
}
