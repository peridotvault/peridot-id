//! Sponsored SOL withdrawal, V4 authorization (ANT-544 B5, ANT-556).
//!
//! V4 sibling of `withdraw_sol` (which stays frozen): identical flow plus the
//! user-approved `max_total_fee` bound on `network_fee + protocol_fee`. The
//! passkey signs the V4 domain-separated payload
//! (op-tag ‖ account_id ‖ nonce ‖ amount ‖ destination ‖ expiry ‖ policy ‖
//! max_total_fee) and the program enforces `total ≤ max_total_fee`
//! (`FeeExceedsMax`) before any value moves. The fee formula follows the signed
//! policy version: v1/v2 both settle the pure 50% row (ANT-747 removed the
//! floor leg; `fee::policy_protocol_bps_v4` / `split_attested_fee`).
//!
//! Lamports are moved directly (no System Program CPI — a System transfer is forbidden
//! when `from` carries data, and the smart account PDA holds SOL + its state).

use crate::{
    auth,
    errors::PeridotError,
    fee::{policy_protocol_bps_v4, split_attested_fee, total_fee},
    state::{verify_nonce, verify_pda, SmartAccount, SmartAccountMut},
    treasury::verify_treasury_pda,
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout (V4 appends `max_total_fee` after `network_fee`):
/// `nonce u64 | amount u64 | destination [u8; 32] | expiry i64 | policy u16 | network_fee u64 | max_total_fee u64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const AMOUNT_OFFSET: usize = 8;
const DESTINATION_OFFSET: usize = 16;
const EXPIRY_OFFSET: usize = 48;
const POLICY_OFFSET: usize = 56;
const NETWORK_FEE_OFFSET: usize = 58;
const MAX_TOTAL_FEE_OFFSET: usize = 66;
const CLIENT_JSON_LEN_OFFSET: usize = 74;

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[WRITE]` destination (receives the SOL)
///   2. `[WRITE]` canonical revenue vault (receives the protocol fee; must be the `[b"treasury"]` PDA vault (ANT-635))
///   3. `[WRITE, SIGNER]` relayer (pays the network fee; receives the exact reimbursement)
///   4. `[]` instructions sysvar (for secp256r1 introspection)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let smart_account = &accounts[0];
    let destination = &accounts[1];
    let treasury = &accounts[2];
    let relayer = &accounts[3];
    let instructions = &accounts[4];

    if !relayer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }
    if destination.address() == smart_account.address() || treasury.address() == smart_account.address() {
        return Err(PeridotError::InvalidDestination.into());
    }
    // Fee recipients are canonical, never caller-chosen: protocol fee goes to the
    // build-time revenue vault, reimbursement goes to the relayer signer.
    // ANT-635 (ANT-638): the protocol fee lands in the program-bound PDA vault
    // `[b"treasury"]` (verified against the runtime program_id), not the
    // build-baked `config::TREASURY` const (removed). Fee math unchanged (D5).
    verify_treasury_pda(treasury, program_id)?;

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let amount = data.read_u64_at(AMOUNT_OFFSET)?;
    let destination_bytes = data.read_array::<32>(DESTINATION_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let policy_version = data.read_u16_at(POLICY_OFFSET)?;
    let network_fee = data.read_u64_at(NETWORK_FEE_OFFSET)?;
    let max_total_fee = data.read_u64_at(MAX_TOTAL_FEE_OFFSET)?;
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data
        .read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let destination_addr = Address::new_from_array(destination_bytes);
    if destination.address() != &destination_addr {
        return Err(PeridotError::InvalidDestination.into());
    }

    let (authority, account_id) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id())
    };
    verify_pda(smart_account, program_id, account_id)?;

    // Version gate before signature verification (safe pre-verify, mirrors V3).
    let bps = policy_protocol_bps_v4(policy_version)?;
    let payload = auth::payload_hash_v4(&[
        &[auth::OP_WITHDRAW_SOL_V4],
        &account_id,
        &nonce.to_le_bytes(),
        &amount.to_le_bytes(),
        &destination_bytes,
        &expiry.to_le_bytes(),
        &policy_version.to_le_bytes(),
        &max_total_fee.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, client_json, &payload)?;

    let (relayer_fee, protocol_fee) = split_attested_fee(network_fee, bps);
    let total = total_fee(relayer_fee, protocol_fee);
    // User-approved bound (ANT-544 B5): revert before any value moves when the
    // attested total exceeds what the passkey authorized.
    if total > max_total_fee {
        return Err(PeridotError::FeeExceedsMax.into());
    }
    if smart_account.lamports() < amount.saturating_add(total) || total < network_fee {
        return Err(PeridotError::InsufficientFunds.into());
    }

    // Effects first (checks-effects-interactions): burn the nonce BEFORE moving
    // value. No CPI on this path (direct lamport moves), but the ordering keeps
    // every spend path uniform for audit cleanliness; failure below reverts
    // atomically, so this is behavior-preserving.
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.increment_nonce();
    drop(data_ref);

    // Move lamports directly: amount to the destination, exact network cost back
    // to the relayer (fee payer), protocol fee to the canonical revenue vault.
    let from = *smart_account;
    let to = *destination;
    let t = *treasury;
    let r = *relayer;
    to.set_lamports(to.lamports() + amount);
    r.set_lamports(r.lamports() + relayer_fee);
    t.set_lamports(t.lamports() + protocol_fee);
    from.set_lamports(from.lamports() - amount - total);

    pinocchio_log::log!("PeridotEvent::TransactionExecuted");
    Ok(())
}
