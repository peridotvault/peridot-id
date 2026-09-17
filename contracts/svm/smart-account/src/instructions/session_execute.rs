//! Gameplay execution authorized by an Ed25519 session key (ADR-010).
//!
//! Security boundary (structurally different from the EVM executor — nothing
//! is ported): the vault PDA that holds economic value NEVER appears in the
//! game CPI. The only signer the program lends is the session PDA, which holds
//! rent-exempt minimum only and which no other program can `invoke_signed`
//! for (seeds resolve under the caller's program id — runtime-proven). Even if
//! the game forwards the session signer's status further, there is no value to
//! move: the vault is absent, and listed protected accounts are hash-pinned
//! before/after the call (owner, lamports, data — hence delegate and
//! close_authority changes are caught even when balances do not move).
//!
//! `remaining_accounts` are rejected outright: the account count must match
//! exactly, so the Neodyme `remaining_accounts` substitution class cannot
//! occur. Upgrade visibility is record-and-log: the game's ProgramData
//! authority + slot refresh `last_seen_*` every execution for backend
//! indexers; there is deliberately no enforcement (ADR-010 §4).

use crate::{
    auth,
    errors::PeridotError,
    programdata,
    state::{verify_session_pda, SessionAccount, SessionAccountMut, SESSION_STATE_LEN},
};
use alloc::vec::Vec;
use pinocchio::{
    account::AccountView,
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    Address, ProgramResult,
};

use super::InstructionData;

/// Instruction data layout:
/// `seq u64 | game_data_len u16 | game_data | meta_count u8 |
///  metas meta_count×(addr[32] ‖ flags u8) | protected_count u8 |
///  protected protected_count×addr[32]`.
/// Meta flags: bit 0 = writable, bit 1 = session-PDA-signer (addr MUST be the
/// session PDA; exactly the delegation proof, mirroring `execute`'s pda_signs).
const SEQ_OFFSET: usize = 0;
const GAME_DATA_LEN_OFFSET: usize = 8;

const FLAG_WRITABLE: u8 = 0x01;
const FLAG_SESSION_SIGNER: u8 = 0x02;

/// Bounds (gameplay instructions are small; the tx size limit binds first).
pub const MAX_SESSION_METAS: usize = 32;
pub const MAX_SESSION_DATA: usize = 1_024;
pub const MAX_PROTECTED: usize = 8;

/// Accounts (exact count — no `remaining_accounts`, ever):
///   0. `[WRITE]` session PDA (record + sole CPI signer)
///   1. `[]` game program (must equal the allowlisted program, never this program)
///   2. `[]` upgrade evidence: the game's ProgramData (upgradeable games) or the
///      game program itself (immutable: native/deprecated loader)
///   3. `[SIGNER]` session Ed25519 key (must equal the registered key)
///   4.. game CPI accounts for each non-session meta, in order
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let session = &accounts[0];
    let game_program = &accounts[1];
    let game_programdata = &accounts[2];
    let session_signer = &accounts[3];

    if !session.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if session.data_len() != SESSION_STATE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    if !session_signer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }

    let seq = data.read_u64_at(SEQ_OFFSET)?;
    let game_data_len = u16::from_le_bytes(data.read_array::<2>(GAME_DATA_LEN_OFFSET)?) as usize;
    if game_data_len > MAX_SESSION_DATA {
        return Err(ProgramError::InvalidInstructionData);
    }
    let game_data = data.read_bytes(GAME_DATA_LEN_OFFSET + 2, game_data_len)?;
    let mut cursor = GAME_DATA_LEN_OFFSET + 2 + game_data_len;
    let meta_count = data.read_bytes(cursor, 1)?[0] as usize;
    if meta_count == 0 || meta_count > MAX_SESSION_METAS {
        return Err(ProgramError::InvalidInstructionData);
    }
    cursor += 1;
    let mut metas: Vec<([u8; 32], u8)> = Vec::with_capacity(meta_count);
    for _ in 0..meta_count {
        let addr = data.read_array::<32>(cursor)?;
        let flags = data.read_bytes(cursor + 32, 1)?[0];
        if flags & !(FLAG_WRITABLE | FLAG_SESSION_SIGNER) != 0 {
            return Err(ProgramError::InvalidInstructionData);
        }
        metas.push((addr, flags));
        cursor += 33;
    }
    let protected_count = data.read_bytes(cursor, 1)?[0] as usize;
    if protected_count > MAX_PROTECTED {
        return Err(ProgramError::InvalidInstructionData);
    }
    cursor += 1;
    let mut protected: Vec<[u8; 32]> = Vec::with_capacity(protected_count);
    for _ in 0..protected_count {
        protected.push(data.read_array::<32>(cursor)?);
        cursor += 32;
    }

    // Load the record first: every check below keys off it.
    let (session_key, account_id, allowed_program, record_seq) = {
        let borrowed = session.try_borrow()?;
        let record = SessionAccount::try_from_bytes(&borrowed)?;
        if !record.is_active() {
            return Err(PeridotError::SessionRevoked.into());
        }
        (
            record.session_key(),
            record.account_id(),
            record.allowed_program(),
            record.seq(),
        )
    };
    if session_signer.address().as_array() != &session_key {
        return Err(PeridotError::Unauthorized.into());
    }
    if seq != record_seq {
        return Err(PeridotError::BadSessionSeq.into());
    }
    verify_session_pda(session, program_id, account_id, session_key)?;

    // Target confinement: exactly the allowlisted game, never this program.
    if game_program.address().as_array() != &allowed_program {
        return Err(PeridotError::SessionScopeViolation.into());
    }
    if game_program.address() == program_id {
        return Err(PeridotError::InvalidTarget.into());
    }
    if !game_program.executable() {
        return Err(PeridotError::InvalidDestination.into());
    }

    // Time bounds on the chain clock (never the device clock).
    let now = Clock::get()?.unix_timestamp;
    {
        let borrowed = session.try_borrow()?;
        let record = SessionAccount::try_from_bytes(&borrowed)?;
        crate::state::check_session_time(record.expires_at(), record.last_used(), now)?;
    }

    // The vault PDA must not appear anywhere in this call. It is derived
    // on-chain (bpf) so a caller cannot rename it away.
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (vault, _) = Address::find_program_address(
            &[b"peridot_id", b"account", &account_id],
            program_id,
        );
        for (addr, _) in metas.iter() {
            if addr == vault.as_array() {
                return Err(PeridotError::SessionScopeViolation.into());
            }
        }
        for view in accounts.iter().skip(4) {
            if view.address() == &vault {
                return Err(PeridotError::SessionScopeViolation.into());
            }
        }
    }

    // Session-signer metas must name the session PDA (the delegation proof);
    // at least one is required so the call cannot be a no-op blessing.
    let mut session_signs = false;
    let mut non_session = 0usize;
    for (addr, flags) in metas.iter() {
        if flags & FLAG_SESSION_SIGNER != 0 {
            if addr != session.address().as_array() {
                return Err(PeridotError::SessionScopeViolation.into());
            }
            session_signs = true;
        } else {
            non_session += 1;
        }
    }
    if !session_signs {
        return Err(PeridotError::Unauthorized.into());
    }
    // Exact account count: non-session metas map 1:1 to accounts[4..].
    // Anything else (the `remaining_accounts` class) fails here.
    if accounts.len() != 4 + non_session {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    // Protected addresses must be a subset of the metas (otherwise the check
    // below could not observe them through this call).
    for p in protected.iter() {
        if !metas.iter().any(|(addr, _)| addr == p) {
            return Err(PeridotError::SessionScopeViolation.into());
        }
    }

    // Upgrade visibility: refresh `last_seen_*` from chain truth every
    // execution. Upgradeable games: parse the verified ProgramData.
    // Immutable games (native/deprecated loader): no upgrade record exists —
    // the evidence account must be the game program itself. Record-and-log
    // only — no enforcement (ADR-010 §4, owner-accepted risk).
    let (seen_slot, seen_auth, seen_has_auth) = match programdata::classify_loader(
        &programdata::owner_bytes(game_program),
    ) {
        programdata::LoaderClass::Upgradeable => {
            let (expected_pd, _) =
                programdata::programdata_address(&Address::new_from_array(allowed_program))?;
            if game_programdata.address() != &expected_pd {
                return Err(PeridotError::InvalidDestination.into());
            }
            let loader = Address::new_from_array(programdata::BPF_LOADER_UPGRADEABLE_ID);
            if !game_programdata.owned_by(&loader) {
                return Err(PeridotError::WrongOwner.into());
            }
            let borrowed = game_programdata.try_borrow()?;
            programdata::parse_programdata(&borrowed)?
        }
        programdata::LoaderClass::ImmutableNative | programdata::LoaderClass::ImmutableDeprecated => {
            if game_programdata.address() != game_program.address() {
                return Err(PeridotError::InvalidDestination.into());
            }
            (0u64, [0u8; 32], false)
        }
        programdata::LoaderClass::Unknown => return Err(PeridotError::WrongOwner.into()),
    };

    // Pre-CPI snapshot of every protected account: lamports, owner, full data
    // hash (covers balances AND delegate/close_authority moves uniformly),
    // plus explicit authority-field snapshots for token-owned accounts.
    struct Snapshot {
        lamports: u64,
        owner: [u8; 32],
        data_hash: [u8; 32],
        token_auth: Option<([u8; 4], [u8; 32], [u8; 4], [u8; 32])>,
    }
    let mut snapshots: Vec<Snapshot> = Vec::with_capacity(protected.len());
    for p in protected.iter() {
        let view = accounts
            .iter()
            .skip(4)
            .find(|v| v.address().as_array() == p)
            .ok_or(PeridotError::SessionScopeViolation)?;
        // The session PDA itself may be protected (rent-pinning): it maps to
        // account 0, which the scan above skips — handle it explicitly.
        let (lamports, owner, data_hash, token_auth) = if p == session.address().as_array() {
            let borrowed = session.try_borrow()?;
            let owner = programdata::owner_bytes(session);
            (session.lamports(), owner, auth::sha256(&borrowed), None)
        } else {
            let borrowed = view.try_borrow()?;
            let owner = programdata::owner_bytes(view);
            let token_auth = if programdata::is_token_program(&owner) {
                Some(
                    programdata::snapshot_token_authorities(&borrowed)
                        .ok_or(PeridotError::SessionScopeViolation)?,
                )
            } else {
                None
            };
            (view.lamports(), owner, auth::sha256(&borrowed), token_auth)
        };
        snapshots.push(Snapshot { lamports, owner, data_hash, token_auth });
    }

    // Build the CPI: session PDA signs via seeds; nothing else gains signer.
    let bump = verify_session_pda(session, program_id, account_id, session_key)?;
    let bump_seed = [bump];
    let seeds = [
        pinocchio::cpi::Seed::from(b"peridot_id".as_slice()),
        pinocchio::cpi::Seed::from(b"session".as_slice()),
        pinocchio::cpi::Seed::from(account_id.as_slice()),
        pinocchio::cpi::Seed::from(session_key.as_slice()),
        pinocchio::cpi::Seed::from(bump_seed.as_slice()),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds[..]);

    let mut cpi_addresses: Vec<Address> = Vec::with_capacity(meta_count);
    let mut cpi_views: Vec<&AccountView> = Vec::with_capacity(meta_count);
    let mut cursor = 4usize;
    for (addr, flags) in metas.iter() {
        let parsed = Address::new_from_array(*addr);
        if flags & FLAG_SESSION_SIGNER != 0 {
            cpi_views.push(session);
        } else {
            let view = accounts.get(cursor).ok_or(ProgramError::NotEnoughAccountKeys)?;
            if view.address() != &parsed {
                return Err(PeridotError::InvalidDestination.into());
            }
            cpi_views.push(view);
            cursor += 1;
        }
        cpi_addresses.push(parsed);
    }
    let cpi_metas: Vec<pinocchio::instruction::InstructionAccount> = cpi_addresses
        .iter()
        .zip(metas.iter())
        .map(|(addr, (_, flags))| {
            pinocchio::instruction::InstructionAccount::new(
                addr,
                flags & FLAG_WRITABLE != 0,
                flags & FLAG_SESSION_SIGNER != 0,
            )
        })
        .collect();
    let target_addr = Address::new_from_array(allowed_program);
    let cpi_ix = pinocchio::instruction::InstructionView {
        program_id: &target_addr,
        data: game_data,
        accounts: &cpi_metas,
    };
    pinocchio::cpi::invoke_signed_with_slice(&cpi_ix, &cpi_views, &[signer])?;

    // Post-CPI invariant check: any change to a protected account reverts.
    // Lamport/owner/data-hash equality catches balance moves, owner swaps
    // (`assign`-then-drain), and delegate/close_authority edits alike.
    for (p, before) in protected.iter().zip(snapshots.iter()) {
        let (lamports, owner, data_hash, token_auth) = if p == session.address().as_array() {
            let borrowed = session.try_borrow()?;
            (session.lamports(), programdata::owner_bytes(session), auth::sha256(&borrowed), None)
        } else {
            let view = accounts
                .iter()
                .skip(4)
                .find(|v| v.address().as_array() == p)
                .ok_or(PeridotError::SessionScopeViolation)?;
            let owner = programdata::owner_bytes(view);
            let borrowed = view.try_borrow()?;
            let token_auth = if programdata::is_token_program(&owner) {
                Some(
                    programdata::snapshot_token_authorities(&borrowed)
                        .ok_or(PeridotError::SessionScopeViolation)?,
                )
            } else {
                None
            };
            (view.lamports(), owner, auth::sha256(&borrowed), token_auth)
        };
        if lamports != before.lamports || owner != before.owner || data_hash != before.data_hash {
            return Err(PeridotError::SessionScopeViolation.into());
        }
        if token_auth != before.token_auth {
            return Err(PeridotError::SessionScopeViolation.into());
        }
    }

    // Effects: seq + inactivity clock + upgrade-visibility snapshot.
    {
        let mut data_ref = session.try_borrow_mut()?;
        let mut record = SessionAccountMut::try_from_bytes(&mut data_ref)?;
        record.advance(now);
        record.record_seen(seen_auth, seen_has_auth, seen_slot);
    }

    pinocchio_log::log!("PeridotEvent::SessionExecuted");
    Ok(())
}
