//! Sponsored SPL-token withdrawal, V4 authorization (ANT-544 B5, ANT-556).
//!
//! V4 sibling of `withdraw_token` (which stays frozen): identical flow plus the
//! user-approved `max_total_fee` bound on `network_fee + protocol_fee`. The
//! passkey signs the V4 domain-separated payload
//! (op-tag ‖ account_id ‖ nonce ‖ amount ‖ destination_ata ‖ expiry ‖ policy ‖
//! max_total_fee ‖ source_ata) and the program enforces `total ≤ max_total_fee`
//! (`FeeExceedsMax`) before the Token CPI. The fee formula follows the signed
//! policy version (v1/v2 both pure 50%; ANT-747 removed the floor leg).

use crate::{
    auth,
    errors::PeridotError,
    fee::{policy_protocol_bps_v4, split_attested_fee, total_fee},
    programdata,
    state::{verify_nonce, verify_pda, SmartAccount, SmartAccountMut},
    treasury::verify_treasury_pda,
};
use pinocchio::{
    account::AccountView,
    cpi::{Seed, Signer},
    error::ProgramError,
    Address, ProgramResult,
};
use pinocchio_token::instructions::Transfer as TokenTransfer;

use super::InstructionData;

/// Instruction data layout (V4 appends `max_total_fee` after `network_fee`):
/// `nonce u64 | amount u64 | destination_ata [u8; 32] | expiry i64 | policy u16 | network_fee u64 | max_total_fee u64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const AMOUNT_OFFSET: usize = 8;
const DESTINATION_ATA_OFFSET: usize = 16;
const EXPIRY_OFFSET: usize = 48;
const POLICY_OFFSET: usize = 56;
const NETWORK_FEE_OFFSET: usize = 58;
const MAX_TOTAL_FEE_OFFSET: usize = 66;
const CLIENT_JSON_LEN_OFFSET: usize = 74;

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
///   6. `[WRITE]` canonical revenue vault (receives the protocol fee; must be the `[b"treasury"]` PDA vault (ANT-635))
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
    // ANT-635 (ANT-638): the protocol fee lands in the program-bound PDA vault
    // `[b"treasury"]` (verified against the runtime program_id), not the
    // build-baked `config::TREASURY` const (removed). Fee math unchanged (D5).
    verify_treasury_pda(treasury, program_id)?;

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let amount = data.read_u64_at(AMOUNT_OFFSET)?;
    let destination_ata_bytes = data.read_array::<32>(DESTINATION_ATA_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let policy_version = data.read_u16_at(POLICY_OFFSET)?;
    let network_fee = data.read_u64_at(NETWORK_FEE_OFFSET)?;
    let max_total_fee = data.read_u64_at(MAX_TOTAL_FEE_OFFSET)?;
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
    // ANT-870 P6.1: Token-2022 extension matrix — see withdraw_token.rs.
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
        programdata::check_token_account_supported(&borrowed)?;
    }
    {
        let borrowed = destination_ata.try_borrow()?;
        if borrowed.len() < TOKEN_ACCOUNT_MIN_LEN {
            return Err(PeridotError::InvalidDestination.into());
        }
        if borrowed[TOKEN_MINT_OFFSET..TOKEN_MINT_OFFSET + 32] != mint.address().as_array()[..] {
            return Err(PeridotError::InvalidDestination.into());
        }
        programdata::check_token_account_supported(&borrowed)?;
    }
    {
        let borrowed = mint.try_borrow()?;
        programdata::check_token_mint_supported(&borrowed)?;
    }

    let (authority, account_id) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id())
    };
    let bump = verify_pda(smart_account, program_id, account_id)?;

    // Version gate before signature verification (safe pre-verify, mirrors V3).
    let bps = policy_protocol_bps_v4(policy_version)?;
    let payload = auth::payload_hash_v4(&[
        &[auth::OP_WITHDRAW_TOKEN_V4],
        &account_id,
        &nonce.to_le_bytes(),
        &amount.to_le_bytes(),
        &destination_ata_bytes,
        &expiry.to_le_bytes(),
        &policy_version.to_le_bytes(),
        &max_total_fee.to_le_bytes(),
        &source_ata.address().as_array()[..],
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, client_json, &payload)?;

    let (relayer_fee, protocol_fee) = split_attested_fee(network_fee, bps);
    let total = total_fee(relayer_fee, protocol_fee);
    // User-approved bound (ANT-544 B5): revert before the Token CPI when the
    // attested total exceeds what the passkey authorized.
    if total > max_total_fee {
        return Err(PeridotError::FeeExceedsMax.into());
    }
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

    // Effects first (checks-effects-interactions): burn the nonce BEFORE the
    // Token-program CPI. A reentrant second call with the same passkey
    // signature then sees a spent nonce and fails; a failed CPI reverts the
    // increment atomically, so this is behavior-preserving.
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.increment_nonce();
    drop(data_ref);

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

    pinocchio_log::log!("PeridotEvent::TransactionExecuted");
    Ok(())
}
