//! Initialize the smart account PDA, V3 authorization (authorized by the future
//! passkey itself).
//!
//! Creation is passkey-signed: the V3 payload binds `op-tag ‖ account_id ‖
//! authority ‖ rp_id_hash`, so only the owner of the new authority can claim the
//! PDA — squatting is impossible without the victim's private key. No expiry/nonce:
//! replaying a creation authorization only fails `AlreadyInitialized` (or recreates
//! the same state). State is written in the V2 layout (112 bytes, RP-ID hash included).

use crate::{
    auth,
    config::BACKEND,
    errors::PeridotError,
    state::{verify_pda, SmartAccountMut, STATE_LEN_V2},
    ID,
};
use pinocchio::{
    account::AccountView,
    cpi::Seed,
    error::ProgramError,
    Address, ProgramResult,
};
use pinocchio_system::create_account_with_minimum_balance_signed;

use super::InstructionData;

/// Instruction data layout:
/// `account_id [u8; 32] | authority [u8; 33] | rp_id_hash [u8; 32] | client_json_len u16 | clientDataJSON`.
const ACCOUNT_ID_OFFSET: usize = 0;
const AUTHORITY_OFFSET: usize = 32;
const RP_ID_OFFSET: usize = 65;
const CLIENT_JSON_LEN_OFFSET: usize = 97;

/// ANT-16(e) creation-leak fix, Option A (ANT-22 spec): direct `initialize`
/// bypasses the 50% sponsored-creation fee that `activate` collects, so it is
/// deprecated — `activate` is the sole production creation path.
///
/// Gate form (ANT-22 Q1, owner: CTO): a plain `const`, default `false`, so
/// testnet/devnet builds keep `initialize` fully functional (plus a
/// deprecation event for drift alerting). Production builds flip this to
/// `true`; the check runs before any other validation so a production binary
/// rejects every direct `initialize` uniformly. A `const` cannot be flipped
/// at runtime by a caller — there is no new signer, money path, or trust
/// root (see ANT-19 gate-flip analysis).
pub const DEPRECATE_DIRECT_INITIALIZE: bool = false;

/// Reject direct creation on production-gated builds. Pure (no account
/// access), so it is host-testable: the `true` arm is pinned by the
/// `initialize_deprecated_gate_is_first` source-ordering test plus the
/// discriminant pin in `errors.rs`.
pub fn check_initialize_allowed() -> ProgramResult {
    if DEPRECATE_DIRECT_INITIALIZE {
        return Err(PeridotError::InitializeDeprecated.into());
    }
    Ok(())
}

/// Accounts:
///   0. `[WRITE, SIGNER]` rent payer (funds the PDA creation)
///   1. `[WRITE]` smart account PDA (must be uninitialized)
///   2. `[]` system program
///   3. `[]` instructions sysvar (for secp256r1 introspection)
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    // ANT-16(e): production-gated builds reject direct creation outright, so
    // the fee-free path can never mint an account where `activate` (and its
    // 50% sponsored-creation fee) was due. Runs before any other validation.
    check_initialize_allowed()?;

    let rent_payer = &accounts[0];
    let smart_account = &accounts[1];
    let instructions = &accounts[3];

    if !rent_payer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    // PID-ownership proof: only the backend (which maps pids to identities) may
    // fund creation. Without this, anyone could squat any unclaimed PDA.
    if rent_payer.address().as_array() != &BACKEND {
        return Err(PeridotError::Forbidden.into());
    }
    if smart_account.data_len() != 0 {
        return Err(PeridotError::AlreadyInitialized.into());
    }

    let account_id = data.read_array::<32>(ACCOUNT_ID_OFFSET)?;
    let authority = data.read_array::<33>(AUTHORITY_OFFSET)?;
    let rp_id_hash = data.read_array::<32>(RP_ID_OFFSET)?;
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;
    let bump = verify_pda(smart_account, program_id, account_id)?;

    // Only the new authority itself can claim this PDA.
    let payload = auth::payload_hash_v3(&[
        &[auth::OP_INITIALIZE],
        &account_id,
        &authority,
        &rp_id_hash,
    ]);
    auth::verify_secp256r1_v2(instructions, &authority, &rp_id_hash, client_json, &payload)?;

    let signer_seeds = [bump];
    let seeds = [
        Seed::from(b"peridot_id".as_slice()),
        Seed::from(b"account".as_slice()),
        Seed::from(account_id.as_slice()),
        Seed::from(signer_seeds.as_slice()),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds[..]);

    // Create the PDA (funded by rent_payer, owned by this program, PDA signs via seeds).
    create_account_with_minimum_balance_signed(
        smart_account,
        STATE_LEN_V2,
        &ID,
        rent_payer,
        None,
        &[signer],
    )?;

    // Write the initial state (V2 with RP-ID hash).
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.initialize(account_id, authority, rp_id_hash);
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AccountInitialized");
    // ANT-16(e): testnet/devnet drift signal — production builds never reach
    // here (gated above), so every direct `initialize` still in use is counted
    // for SDK-migration alerting (ANT-16(c) sink; threshold owner: DevOpsEngineer).
    pinocchio_log::log!("PeridotEvent::AccountInitializeDeprecated");
    Ok(())
}
