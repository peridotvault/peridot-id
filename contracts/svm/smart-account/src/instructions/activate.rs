//! Activate a user's smart account, V3 authorization (Peridot-sponsored activation
//! with attested network reimbursement + fixed protocol percentage).
//!
//! The user deposits SOL directly to their deterministic (uninitialized) PDA address. When
//! the backend detects sufficient funds it runs activation: a Peridot relayer signs the
//! tx and an optional top-up brings the PDA to rent-exempt, then this instruction claims
//! the account and reimburses the attested `network_fee` in full to the relayer plus
//! `protocol_fee` (recomputed on-chain from the signed fee-policy version) to the
//! canonical revenue vault — all in one atomic transaction. No temporary wallet is
//! created; the user's deposited balance stays on the one PDA address.
//!
//! The claim itself is passkey-signed: the V3 payload binds
//! `op-tag ‖ account_id ‖ authority ‖ rp_id_hash ‖ policy ‖ expiry` (no amounts —
//! network costs float with gas by design), so a stranger can neither squat the PDA
//! nor divert funds or change the fee policy — only the new authority's key
//! authorizes. Fee recipients are canonical, never caller-chosen.
//!
//! Handles both cases:
//!   * account is empty  → `create_account_with_minimum_balance_signed` creates it (payer funds rent)
//!   * account is funded → the same helper tops-up to rent (if needed) then assigns + resizes,
//!     so a raw System transfer to the uninitialized address is consumed safely.

use crate::{
    auth,
    config::{BACKEND, TREASURY},
    errors::PeridotError,
    fee::{policy_protocol_bps, split_attested_fee, total_fee},
    state::{verify_pda, SmartAccountMut, STATE_LEN_V2},
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
/// `account_id [u8; 32] | authority [u8; 33] | rp_id_hash [u8; 32] | policy u16 | expiry i64 | network_fee u64 | client_json_len u16 | clientDataJSON`.
const ACCOUNT_ID_OFFSET: usize = 0;
const AUTHORITY_OFFSET: usize = 32;
const RP_ID_OFFSET: usize = 65;
const POLICY_OFFSET: usize = 97;
const EXPIRY_OFFSET: usize = 99;
const NETWORK_FEE_OFFSET: usize = 107;
const CLIENT_JSON_LEN_OFFSET: usize = 115;

/// Accounts:
///   0. `[WRITE, SIGNER]` relayer (Peridot float; pays the network fee / rent, receives the exact reimbursement)
///   1. `[WRITE]` smart account PDA (must be uninitialized / system-owned)
///   2. `[WRITE]` canonical revenue vault (receives the protocol fee; must equal `config::TREASURY`)
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
    if treasury.address().as_array() != &TREASURY {
        return Err(PeridotError::InvalidDestination.into());
    }

    let account_id = data.read_array::<32>(ACCOUNT_ID_OFFSET)?;
    let authority = data.read_array::<33>(AUTHORITY_OFFSET)?;
    let rp_id_hash = data.read_array::<32>(RP_ID_OFFSET)?;
    let policy_version = data.read_u16_at(POLICY_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let network_fee = data.read_u64_at(NETWORK_FEE_OFFSET)?;
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    let bump = verify_pda(smart_account, program_id, account_id)?;

    // Only the new authority authorizes the claim and the fee policy.
    let payload = auth::payload_hash_v3(&[
        &[auth::OP_ACTIVATE],
        &account_id,
        &authority,
        &rp_id_hash,
        &policy_version.to_le_bytes(),
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, &rp_id_hash, client_json, &payload)?;

    let bps = policy_protocol_bps(policy_version)?;

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
        STATE_LEN_V2,
        &ID,
        relayer,
        None,
        &[signer.clone()],
    )?;

    let (relayer_fee, protocol_fee) = split_attested_fee(network_fee, bps);
    let total = total_fee(relayer_fee, protocol_fee);

    // Rent floor: after claiming, the account must keep at least the rent-exempt amount.
    let rent = Rent::get()?.try_minimum_balance(STATE_LEN_V2)?;
    if smart_account.lamports() < rent.saturating_add(total) || total < network_fee {
        return Err(PeridotError::InsufficientFunds.into());
    }

    // Reimburse exact network cost (relayer) + protocol fee (revenue vault).
    //
    // Move lamports directly, exactly like withdraw_sol — a System `Transfer` is forbidden
    // when `from` carries data, and this PDA now holds program-owned state.
    let from = *smart_account;
    let t = *treasury;
    let r = *relayer;
    r.set_lamports(r.lamports() + relayer_fee);
    t.set_lamports(t.lamports() + protocol_fee);
    from.set_lamports(from.lamports() - total);

    // Write the initial state (authority = the user's passkey, v2 with RP-ID hash).
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.initialize(account_id, authority, rp_id_hash);
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AccountActivated");
    Ok(())
}
