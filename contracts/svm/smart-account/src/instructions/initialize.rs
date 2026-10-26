//! Initialize the smart account PDA, V3 authorization (historical direct path).
//!
//! PERMANENTLY DISABLED (ANT-16(e) + ANT-612, ANT-610 spec section 5.1):
//! direct `initialize` bypasses the 50% sponsored-creation fee, so every build
//! rejects it with `InitializeDeprecated` before any other validation.
//! `activate`/`activate_v4` are the sole creation paths. The code below the
//! gate is retained for shape/decoder stability only (discriminant 0 still
//! decodes, then rejects — never shifted).
//!
//! Historical note: creation used to be passkey-signed with the V3 payload
//! binding `op-tag ‖ account_id ‖ authority`, so only the owner of the new
//! authority could claim the PDA. That property now lives in `activate`.

use crate::{
    auth,
    errors::PeridotError,
    state::{verify_pda, SmartAccountMut, STATE_LEN_V2},
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
/// `account_id [u8; 32] | authority [u8; 33] | client_json_len u16 | clientDataJSON`.
const ACCOUNT_ID_OFFSET: usize = 0;
const AUTHORITY_OFFSET: usize = 32;
const CLIENT_JSON_LEN_OFFSET: usize = 65;

/// ANT-16(e) creation-leak fix, Option A (ANT-22 spec), finalized by ANT-612
/// (ANT-610 spec section 5.1): direct `initialize` bypasses the 50%
/// sponsored-creation fee that `activate` collects, so it is permanently
/// disabled — `activate`/`activate_v4` are the sole creation paths in every
/// build. There is no toggle back: the const below is `true` unconditionally
/// and the check runs before any other validation, so every build rejects
/// direct `initialize` uniformly with `InitializeDeprecated`. The
/// discriminator (0) is retained so old SDK decoders keep working (frozen
/// V3 discriminant rule — index 0 decodes, then rejects; never shifted).
/// A `const` cannot be flipped at runtime by a caller — there is no new
/// signer, money path, or trust root (see ANT-19 gate-flip analysis).
pub const DEPRECATE_DIRECT_INITIALIZE: bool = true;

/// Reject direct creation on all builds. Pure (no account
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
///   0. `[WRITE, SIGNER]` rent payer (historical; the instruction always
///      rejects before reaching account validation — retained for
///      decoder/shape stability only)
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

    // ANT-16(e) + ANT-612: the fee-free path can never mint an account where
    // `activate` (and its 50% sponsored-creation fee) was due. Runs before any
    // other validation; unreachable code below is retained for shape stability.
    check_initialize_allowed()?;

    let rent_payer = &accounts[0];
    let smart_account = &accounts[1];
    let instructions = &accounts[3];

    if !rent_payer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    // ANT-612: the BACKEND allowlist is gone (any submitter may relay
    // `activate`; anti-squat is the passkey signature). This instruction
    // rejects above regardless, so no payer check remains here.
    if smart_account.data_len() != 0 {
        return Err(PeridotError::AlreadyInitialized.into());
    }

    let account_id = data.read_array::<32>(ACCOUNT_ID_OFFSET)?;
    let authority = data.read_array::<33>(AUTHORITY_OFFSET)?;
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;
    let bump = verify_pda(smart_account, program_id, account_id)?;

    // Only the new authority itself can claim this PDA.
    let payload = auth::payload_hash_v3(&[
        &[auth::OP_INITIALIZE],
        &account_id,
        &authority,
    ]);
    auth::verify_secp256r1_v2(instructions, &authority, client_json, &payload)?;

    let signer_seeds = [bump];
    let seeds = [
        Seed::from(b"peridot_id".as_slice()),
        Seed::from(b"account".as_slice()),
        Seed::from(account_id.as_slice()),
        Seed::from(signer_seeds.as_slice()),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds[..]);

    // Create the PDA (funded by rent_payer, owned by this program, PDA signs via seeds).
    // Owner is the runtime `program_id` (ANT-211: equals the baked `ID` — the
    // entrypoint rejects anything else — but the runtime value is the authority
    // so the two can never diverge).
    create_account_with_minimum_balance_signed(
        smart_account,
        STATE_LEN_V2,
        program_id,
        rent_payer,
        None,
        &[signer],
    )?;

    // Write the initial state (domain-free 80 bytes).
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.initialize(account_id, authority);
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AccountInitialized");
    // Unreachable on every build (gated above): retained so the success event
    // shape is unchanged for indexers if the path is ever re-enabled by spec.
    pinocchio_log::log!("PeridotEvent::AccountInitializeDeprecated");
    Ok(())
}
