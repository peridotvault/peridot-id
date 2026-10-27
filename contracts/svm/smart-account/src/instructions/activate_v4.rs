//! Activate a user's smart account, V4 authorization (ANT-544 B5, ANT-556).
//!
//! V4 sibling of `activate` (which stays frozen): identical claim semantics
//! (pre-funded PDA, permissionless submitter — ANT-612 — plus rent floor) plus
//! the user-approved `max_total_fee` bound on `network_fee + protocol_fee`. The passkey signs the
//! V4 domain-separated payload
//! (op-tag ‖ account_id ‖ authority ‖ policy ‖ max_total_fee ‖ expiry) and the
//! program enforces `total ≤ max_total_fee` (`FeeExceedsMax`) before claiming.
//! The fee formula follows the signed policy version (v1/v2 both pure 50%;
//! ANT-747 removed the floor leg).

use crate::{
    auth,
    errors::PeridotError,
    fee::{policy_protocol_bps_v4, split_attested_fee, total_fee},
    state::{verify_pda, SmartAccountMut, STATE_LEN_V2},
    treasury::verify_treasury_pda,
};
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{rent::Rent, Sysvar},
    Address, ProgramResult,
};
use pinocchio_system::create_account_with_minimum_balance_signed;

use super::InstructionData;

/// Instruction data layout (V4 appends `max_total_fee` after `network_fee`):
/// `account_id [u8; 32] | authority [u8; 33] | policy u16 | expiry i64 | network_fee u64 | max_total_fee u64 | client_json_len u16 | clientDataJSON`.
const ACCOUNT_ID_OFFSET: usize = 0;
const AUTHORITY_OFFSET: usize = 32;
const POLICY_OFFSET: usize = 65;
const EXPIRY_OFFSET: usize = 67;
const NETWORK_FEE_OFFSET: usize = 75;
const MAX_TOTAL_FEE_OFFSET: usize = 83;
const CLIENT_JSON_LEN_OFFSET: usize = 91;

/// Accounts:
///   0. `[WRITE, SIGNER]` submitter (any payer — ANT-612 permissionless;
///      receives the exact network-fee reimbursement)
///   1. `[WRITE]` smart account PDA (must be uninitialized / system-owned)
///   2. `[WRITE]` canonical revenue vault (receives the protocol fee; must be the `[b"treasury"]` PDA vault (ANT-635))
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
    // ANT-612 (ANT-610 spec section 5): permissionless creation — any signer
    // may submit. Anti-squat is the passkey signature below; the protocol fee
    // still flows to the canonical vault on every claim.
    // The PDA may not already be program-owned or initialized.
    if smart_account.data_len() != 0 || smart_account.owned_by(program_id) {
        return Err(PeridotError::AlreadyInitialized.into());
    }
    if treasury.address() == smart_account.address() {
        return Err(PeridotError::InvalidDestination.into());
    }
    // ANT-635 (ANT-638): the protocol fee lands in the program-bound PDA vault
    // `[b"treasury"]` (verified against the runtime program_id), not a
    // build-baked const. Fee math unchanged. Creation stays permissionless
    // (ANT-612): any signer may submit; no gate remains.
    verify_treasury_pda(treasury, program_id)?;

    let account_id = data.read_array::<32>(ACCOUNT_ID_OFFSET)?;
    let authority = data.read_array::<33>(AUTHORITY_OFFSET)?;
    let policy_version = data.read_u16_at(POLICY_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let network_fee = data.read_u64_at(NETWORK_FEE_OFFSET)?;
    let max_total_fee = data.read_u64_at(MAX_TOTAL_FEE_OFFSET)?;
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let bump = verify_pda(smart_account, program_id, account_id)?;

    // Version gate before signature verification (safe pre-verify, mirrors V3).
    let bps = policy_protocol_bps_v4(policy_version)?;
    // Only the new authority authorizes the claim, the fee policy, and the cap.
    let payload = auth::payload_hash_v4(&[
        &[auth::OP_ACTIVATE_V4],
        &account_id,
        &authority,
        &policy_version.to_le_bytes(),
        &max_total_fee.to_le_bytes(),
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, client_json, &payload)?;

    let signer_seeds = [bump];
    let seeds = [
        pinocchio::cpi::Seed::from(b"peridot_id".as_slice()),
        pinocchio::cpi::Seed::from(b"account".as_slice()),
        pinocchio::cpi::Seed::from(account_id.as_slice()),
        pinocchio::cpi::Seed::from(signer_seeds.as_slice()),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds[..]);

    let (relayer_fee, protocol_fee) = split_attested_fee(network_fee, bps);
    let total = total_fee(relayer_fee, protocol_fee);
    // User-approved bound (ANT-544 B5): checked BEFORE the claim CPI so an
    // over-cap activation never touches chain state (no squat window either way —
    // the whole instruction is atomic).
    if total > max_total_fee {
        return Err(PeridotError::FeeExceedsMax.into());
    }

    // Claim the account: create (if empty) or top-up→assign→allocate (if pre-funded).
    // Payer = submitter (any signer). Rent is paid only up to the rent-exempt amount for the state.
    create_account_with_minimum_balance_signed(
        smart_account,
        STATE_LEN_V2,
        program_id,
        relayer,
        None,
        &[signer.clone()],
    )?;

    // Rent floor: after claiming, the account must keep at least the rent-exempt amount.
    let rent = Rent::get()?.try_minimum_balance(STATE_LEN_V2)?;
    if smart_account.lamports() < rent.saturating_add(total) || total < network_fee {
        return Err(PeridotError::InsufficientFunds.into());
    }

    // Reimburse exact network cost (submitter) + protocol fee (revenue vault).
    let from = *smart_account;
    let t = *treasury;
    let r = *relayer;
    r.set_lamports(r.lamports() + relayer_fee);
    t.set_lamports(t.lamports() + protocol_fee);
    from.set_lamports(from.lamports() - total);

    // Write the initial state (authority = the user's passkey, domain-free 80 bytes).
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.initialize(account_id, authority);
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AccountActivated");
    Ok(())
}
