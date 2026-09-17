//! Register a gameplay session, owner authorization (secp256r1 passkey, one-time).
//!
//! Binds an Ed25519 session key plus one allowlisted game program to a fresh
//! session PDA (`["peridot_id", "session", account_id, session_pubkey]`).
//! Gameplay authorization afterwards is the session key signing the transaction
//! envelope plus on-chain record checks — no P-256 ceremony per action, and no
//! precompile cost per gameplay transaction.
//!
//! The program creates the session PDA itself (system `create_account` CPI
//! signed with the session seeds — a PDA cannot sign a client-side create).
//! Rent is exactly the exempt minimum, floated by the transaction payer
//! (relayer) and reclaimable by the owner via `close_session`.

use crate::{
    auth,
    errors::PeridotError,
    programdata,
    state::{
        verify_nonce, verify_pda, verify_session_pda, SessionAccountMut, SmartAccount, SmartAccountMut,
        SESSION_STATE_LEN,
    },
};
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | session_pubkey [u8; 32] | allowed_program [u8; 32] |
///  expires_at i64 | rec_has_authority u8 | rec_authority [u8; 32] |
///  rec_slot u64 | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const SESSION_KEY_OFFSET: usize = 8;
const PROGRAM_OFFSET: usize = 40;
const EXPIRES_AT_OFFSET: usize = 72;
const REC_HAS_AUTH_OFFSET: usize = 80;
const REC_AUTH_OFFSET: usize = 81;
const REC_SLOT_OFFSET: usize = 113;
const EXPIRY_OFFSET: usize = 121;
const CLIENT_JSON_LEN_OFFSET: usize = 129;

/// Accounts:
///   0. `[WRITE]` vault PDA (binds the session; its owner nonce is consumed)
///   1. `[WRITE]` session PDA (must not exist yet; created here for exact rent)
///   2. `[]` instructions sysvar (secp256r1 introspection)
///   3. `[]` upgrade evidence: the game's ProgramData (upgradeable games) or the
///      game program account itself (immutable: native/deprecated loader)
///   4. `[]` game program (loader class read from its owner)
///   5. `[WRITE, SIGNER]` payer (floats exactly the rent-exempt minimum)
///   6. `[]` system program
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 7 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let vault = &accounts[0];
    let session = &accounts[1];
    let instructions = &accounts[2];
    let upgrade_evidence = &accounts[3];
    let game_program = &accounts[4];
    let payer = &accounts[5];
    let system_program = &accounts[6];

    if !vault.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if !payer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    if system_program.address() != &pinocchio_system::ID {
        return Err(PeridotError::InvalidDestination.into());
    }
    // Fresh session PDA only: unallocated (system-owned, zero data).
    if session.data_len() != 0 {
        return Err(PeridotError::AlreadyInitialized.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let session_key = data.read_array::<32>(SESSION_KEY_OFFSET)?;
    let allowed_program_bytes = data.read_array::<32>(PROGRAM_OFFSET)?;
    let expires_at = i64::from_le_bytes(data.read_array::<8>(EXPIRES_AT_OFFSET)?);
    let rec_has_auth = data.read_bytes(REC_HAS_AUTH_OFFSET, 1)?[0] != 0;
    let rec_authority = data.read_array::<32>(REC_AUTH_OFFSET)?;
    let rec_slot = u64::from_le_bytes(data.read_array::<8>(REC_SLOT_OFFSET)?);
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data.read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    // The allowlisted game must be named explicitly; its loader class decides
    // how upgrade evidence is verified below.
    let allowed_program = Address::new_from_array(allowed_program_bytes);
    if allowed_program == *program_id {
        return Err(PeridotError::InvalidTarget.into());
    }
    if game_program.address() != &allowed_program {
        return Err(PeridotError::InvalidDestination.into());
    }

    // Fresh session PDA only; derivation binds (account, session key).
    // (Length is checked at entry: only an unallocated account reaches here.)
    let (authority, account_id, rp_id_hash) = {
        let borrowed = vault.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.rp_id_hash()?)
    };
    verify_pda(vault, program_id, account_id)?;
    let bump = verify_session_pda(session, program_id, account_id, session_key)?;

    // Session lifetime: future-bound, at most 24h (Clock sysvar, not device time).
    let now = Clock::get()?.unix_timestamp;
    if expires_at <= now {
        return Err(PeridotError::Expired.into());
    }
    if expires_at - now > auth::SESSION_MAX_TTL_SECS {
        return Err(PeridotError::SessionTtlExceeded.into());
    }

    // Upgrade evidence, by loader class. Upgradeable games: the passed
    // ProgramData must derive correctly, be loader-owned, parse, and match the
    // client-declared (owner-signed) snapshot. Immutable games (native or
    // deprecated-loader programs) carry no upgrade record: the evidence account
    // must be the game program itself and the snapshot must claim none.
    // Unknown loaders fail closed.
    let (snapshot_slot, snapshot_auth, snapshot_has_auth) = match programdata::classify_loader(
        &programdata::owner_bytes(game_program),
    ) {
        programdata::LoaderClass::Upgradeable => {
            let (expected_pd, _) = programdata::programdata_address(&allowed_program)?;
            if upgrade_evidence.address() != &expected_pd {
                return Err(PeridotError::InvalidDestination.into());
            }
            let loader = Address::new_from_array(programdata::BPF_LOADER_UPGRADEABLE_ID);
            if !upgrade_evidence.owned_by(&loader) {
                return Err(PeridotError::WrongOwner.into());
            }
            let borrowed = upgrade_evidence.try_borrow()?;
            programdata::parse_programdata(&borrowed)?
        }
        programdata::LoaderClass::ImmutableNative | programdata::LoaderClass::ImmutableDeprecated => {
            if upgrade_evidence.address() != game_program.address() {
                return Err(PeridotError::InvalidDestination.into());
            }
            (0u64, [0u8; 32], false)
        }
        programdata::LoaderClass::Unknown => return Err(PeridotError::WrongOwner.into()),
    };
    if snapshot_slot != rec_slot
        || snapshot_has_auth != rec_has_auth
        || (rec_has_auth && snapshot_auth != rec_authority)
    {
        return Err(PeridotError::SessionScopeViolation.into());
    }

    let has_byte = [u8::from(rec_has_auth)];
    let payload = auth::payload_hash_session(&[
        &[auth::OP_REGISTER_SESSION],
        &account_id,
        &nonce.to_le_bytes(),
        &session_key,
        &allowed_program_bytes,
        &expires_at.to_le_bytes(),
        &has_byte,
        &rec_authority,
        &rec_slot.to_le_bytes(),
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, &rp_id_hash, client_json, &payload)?;

    // Create the session PDA for exactly the rent-exempt minimum, signed with
    // the session seeds (a PDA cannot sign a client-side create).
    {
        let bump_seed = [bump];
        let seeds = [
            pinocchio::cpi::Seed::from(b"peridot_id".as_slice()),
            pinocchio::cpi::Seed::from(b"session".as_slice()),
            pinocchio::cpi::Seed::from(account_id.as_slice()),
            pinocchio::cpi::Seed::from(session_key.as_slice()),
            pinocchio::cpi::Seed::from(bump_seed.as_slice()),
        ];
        let signer = pinocchio::cpi::Signer::from(&seeds[..]);
        pinocchio_system::instructions::CreateAccount::with_minimum_balance(
            payer,
            session,
            SESSION_STATE_LEN as u64,
            program_id,
            None,
        )?
        .invoke_signed(&[signer])?;
    }
    {
        let mut data_ref = session.try_borrow_mut()?;
        let mut record = SessionAccountMut::try_from_bytes(&mut data_ref)?;
        record.initialize(
            session_key,
            account_id,
            expires_at,
            now,
            allowed_program_bytes,
            snapshot_auth,
            snapshot_has_auth,
            snapshot_slot,
            bump,
        );
    }
    {
        let mut data_ref = vault.try_borrow_mut()?;
        let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
        state.increment_nonce();
    }

    pinocchio_log::log!("PeridotEvent::SessionRegistered");
    Ok(())
}
