//! Gameplay execution authorized by an Ed25519 session key (WHITEPAPER.md §11).
//!
//! Security boundary (structurally different from the EVM executor — nothing
//! is ported): the vault PDA that holds economic value is passed READ-ONLY at
//! index 0 solely to read the session-generation epoch (ANT-863 B3) — it is
//! NEVER forwarded into the game CPI. The only signer the program lends is
//! the session PDA, which holds rent-exempt minimum only and which no other
//! program can `invoke_signed` for (seeds resolve under the caller's program
//! id — runtime-proven). Even if the game forwards the session signer's
//! status further, there is no value to move: the vault is absent from the
//! CPI, and listed protected accounts are hash-pinned before/after the call
//! (owner, lamports, data — hence delegate and close_authority changes are
//! caught even when balances do not move).
//!
//! `remaining_accounts` are rejected outright: the account count must match
//! exactly, so the Neodyme `remaining_accounts` substitution class cannot
//! occur. Upgrade visibility is record-and-log: the game's ProgramData
//! authority + slot refresh `last_seen_*` every execution for backend
//! indexers; there is deliberately no enforcement (WHITEPAPER.md §11).
//!
//! ANT-863 B3: the vault epoch check makes rotation revoke sessions. A
//! session registered before the latest rotation carries an older stamped
//! generation than the vault and fails with `SessionStaleGeneration` —
//! re-register after rotating. The check reads the vault through the
//! passed account (not the CPI path), so a spoofed vault cannot pass:
//! the PDA is derived from the record's own `account_id`.

use crate::{
    auth,
    errors::PeridotError,
    programdata,
    state::{
        verify_pda, verify_session_pda, SessionAccount, SessionAccountMut, SmartAccount,
        SESSION_STATE_LEN, SESSION_STATE_LEN_V1,
    },
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
///   0. `[]` vault PDA (read-only; epoch source for the ANT-863 B3
///      generation check — never forwarded into the game CPI)
///   1. `[WRITE]` session PDA (record + sole CPI signer)
///   2. `[]` game program (must equal the allowlisted program, never this program)
///   3. `[]` upgrade evidence: the game's ProgramData (upgradeable games) or the
///      game program itself (immutable: native/deprecated loader)
///   4. `[SIGNER]` session Ed25519 key (must equal the registered key)
///   5.. game CPI accounts for each non-session meta, in order
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let vault = &accounts[0];
    let session = &accounts[1];
    let game_program = &accounts[2];
    let game_programdata = &accounts[3];
    let session_signer = &accounts[4];

    if !session.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if !vault.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    // v2 (206B) is the write format; legacy v1 (205B) records execute
    // normally until the first post-upgrade rotation (generation 0 == every
    // legacy vault epoch). Version gating lives in `try_from_bytes` below.
    if session.data_len() != SESSION_STATE_LEN && session.data_len() != SESSION_STATE_LEN_V1 {
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
    let (session_key, account_id, allowed_program, record_seq, record_generation) = {
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
            record.generation(),
        )
    };
    // ANT-863 B3 first: a session that predates the latest rotation is dead —
    // report the actionable error before signer/sequence details. Both PDAs
    // derive from the record's own account_id, so a spoofed vault cannot pass.
    verify_session_pda(session, program_id, account_id, session_key)?;
    verify_pda(vault, program_id, account_id)?;
    {
        let borrowed = vault.try_borrow()?;
        let vault_state = SmartAccount::try_from_bytes(&borrowed)?;
        crate::state::check_session_generation(record_generation, vault_state.session_generation())?;
    }
    if session_signer.address().as_array() != &session_key {
        return Err(PeridotError::Unauthorized.into());
    }
    if seq != record_seq {
        return Err(PeridotError::BadSessionSeq.into());
    }

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

    // The vault PDA must not appear anywhere in this call EXCEPT as the
    // read-only epoch source at index 0. It is derived on-chain (bpf) from
    // the record's own account_id (checked above), so a caller cannot rename
    // it away — and it is never forwarded into the CPI below.
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (vault_addr, _) = Address::find_program_address(
            &[b"peridot_id", b"account", &account_id],
            program_id,
        );
        debug_assert_eq!(vault.address(), &vault_addr);
        for (addr, _) in metas.iter() {
            if addr == vault_addr.as_array() {
                return Err(PeridotError::SessionScopeViolation.into());
            }
        }
        for view in accounts.iter().skip(5) {
            if view.address() == &vault_addr {
                return Err(PeridotError::SessionScopeViolation.into());
            }
        }
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        // Host stubs skip PDA derivation (no bpf syscall); the exact-count
        // check below still pins the account layout for unit tests.
        for (addr, _) in metas.iter() {
            if addr == vault.address().as_array() {
                return Err(PeridotError::SessionScopeViolation.into());
            }
        }
        for view in accounts.iter().skip(5) {
            if view.address() == vault.address() {
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
    // Exact account count: non-session metas map 1:1 to accounts[5..].
    // Anything else (the `remaining_accounts` class) fails here.
    if accounts.len() != 5 + non_session {
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
    // only — no enforcement (WHITEPAPER.md §11, owner-accepted risk).
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

    // Effects first (checks-effects-interactions): consume the sequence number
    // BEFORE the untrusted game CPI. A reentrant second call with the same seq
    // then fails `BadSessionSeq`; a failed CPI or a post-CPI invariant violation
    // reverts the advance atomically, so this is behavior-preserving. The
    // upgrade-visibility snapshot travels with the same write (record-and-log).
    {
        let mut data_ref = session.try_borrow_mut()?;
        let mut record = SessionAccountMut::try_from_bytes(&mut data_ref)?;
        record.advance(now);
        record.record_seen(seen_auth, seen_has_auth, seen_slot);
    }

    // C3 per-execution spend pin (ANT-544 C3, ANT-556): the session PDA holds
    // the rent-exempt minimum ONLY, and the outer transaction fee is paid by
    // the session signer — never from this PDA. Baseline its lamports here; any
    // decrease observed after the CPI (a game draining session rent via the
    // session-PDA signer, e.g. a system transfer) reverts with
    // `SessionSpendExceeded`. Increases are allowed (harmless top-ups). This is
    // the per-execution gas/rent spend cap: zero net outflow per call.
    // (A snapshot is a read, not an interaction — effects-first ordering holds.)
    let session_lamports_before = session.lamports();

    // Post-effects, pre-CPI snapshot of every protected account: lamports,
    // owner, full data hash (covers balances AND delegate/close_authority moves
    // uniformly), plus explicit authority-field snapshots for token-owned
    // accounts. The snapshot MUST be taken after the `advance`/`record_seen`
    // write above: both mutate the session record bytes (`seq`, `last_used`,
    // `seen_*`), so a pre-advance snapshot of a protected session PDA (the
    // rent-pinning case, `session_execute.rs:274`) would never match the
    // post-CPI state and every such call would revert with
    // `SessionScopeViolation` (0x15) even when the game behaved perfectly.
    // Snapshot-after-effects keeps checks-effects-interactions (a snapshot is
    // a read, not an interaction) while baselining the invariant on the exact
    // bytes the game observes.
    struct Snapshot {
        lamports: u64,
        owner: [u8; 32],
        data_hash: [u8; 32],
        token_auth: Option<([u8; 4], [u8; 32], [u8; 4], [u8; 32])>,
    }
    let mut snapshots: Vec<Snapshot> = Vec::with_capacity(protected.len());
    for p in protected.iter() {
        // The session PDA itself may be protected (rent-pinning): it maps to
        // account 1, which the scan below skips — check it first, mirroring
        // the post-CPI loop.
        let (lamports, owner, data_hash, token_auth) = if p == session.address().as_array() {
            let borrowed = session.try_borrow()?;
            let owner = programdata::owner_bytes(session);
            (session.lamports(), owner, auth::sha256(&borrowed), None)
        } else {
            let view = accounts
                .iter()
                .skip(5)
                .find(|v| v.address().as_array() == p)
                .ok_or(PeridotError::SessionScopeViolation)?;
            let borrowed = view.try_borrow()?;
            let owner = programdata::owner_bytes(view);
            let token_auth = if programdata::is_token_program(&owner) {
                // ANT-870 P6.1: extension matrix first — an extended token
                // account with unsupported semantics (hidden balances, fee
                // skims, hooks) must fail closed here, not just mismatch the
                // post-CPI hash. Supported extended accounts still snapshot
                // the base authority fields below.
                programdata::check_token_account_supported(&borrowed)?;
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
    // Game accounts start at index 5 (0 = vault epoch source, 1-4 = session
    // record, game, evidence, signer). The vault is never forwarded.
    let mut cursor = 5usize;
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
    // (The seq was already consumed above; a violation here reverts it too.)
    // C3 spend pin: the session PDA itself must not have lost lamports across
    // the call (checked even when it is not in the protected list).
    check_session_spend_pinned(session_lamports_before, session.lamports())?;
    for (p, before) in protected.iter().zip(snapshots.iter()) {
        let (lamports, owner, data_hash, token_auth) = if p == session.address().as_array() {
            let borrowed = session.try_borrow()?;
            (session.lamports(), programdata::owner_bytes(session), auth::sha256(&borrowed), None)
        } else {
            let view = accounts
                .iter()
                .skip(5)
                .find(|v| v.address().as_array() == p)
                .ok_or(PeridotError::SessionScopeViolation)?;
            let owner = programdata::owner_bytes(view);
            let borrowed = view.try_borrow()?;
            // No extension re-check needed here: the pre-CPI gate admitted
            // only supported extension sets, and any extension mutation lands
            // in account data, which the data-hash equality below pins.
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

    pinocchio_log::log!("PeridotEvent::SessionExecuted");
    Ok(())
}

/// C3 per-execution spend pin (ANT-544 C3, ANT-556): the session PDA's lamports
/// must not decrease across one gameplay execution. Pure helper so the rule is
/// unit-testable on the host (the full CPI flow is validator-gated).
pub fn check_session_spend_pinned(before: u64, after: u64) -> ProgramResult {
    if after < before {
        return Err(PeridotError::SessionSpendExceeded.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::PeridotError;

    #[test]
    fn spend_pin_allows_unchanged_or_topped_up() {
        assert!(check_session_spend_pinned(1_000, 1_000).is_ok());
        assert!(check_session_spend_pinned(1_000, 1_001).is_ok());
        assert!(check_session_spend_pinned(0, 0).is_ok());
    }

    #[test]
    fn spend_pin_rejects_any_decrease() {
        // Even a 1-lamport drain is a spend violation (cap = zero net outflow).
        let err = check_session_spend_pinned(1_000, 999).unwrap_err();
        assert_eq!(err, PeridotError::SessionSpendExceeded.into());
        let err = check_session_spend_pinned(1_000, 0).unwrap_err();
        assert_eq!(err, PeridotError::SessionSpendExceeded.into());
    }

    #[test]
    fn spend_exceeded_uses_fresh_discriminant() {
        // Additive-only error table: the new variant is 24, the reintroduced
        // fee cap is back at its retired slot 12, V3 discriminants untouched.
        assert_eq!(PeridotError::SessionSpendExceeded as u32, 24);
        assert_eq!(PeridotError::FeeExceedsMax as u32, 12);
        assert_eq!(PeridotError::UnknownFeePolicy as u32, 13);
    }

    #[test]
    fn stale_generation_uses_fresh_discriminant() {
        // ANT-863 B3 rotation/session epoch: additive-only error 29 (the
        // 25-28 vault family is taken; V3 discriminants untouched).
        assert_eq!(PeridotError::SessionStaleGeneration as u32, 29);
    }

    #[test]
    fn v4_discriminants_are_additive() {
        // New V4 spend paths are 11-14; V3 0-10 unchanged (old SDK decoders
        // keep working; op-tags equal discriminators per auth.rs convention).
        // ANT-635 vault instructions extend the range at 15-18 (ANT-638).
        use super::super::Instruction;
        assert_eq!(Instruction::try_from(6).unwrap(), Instruction::Execute);
        assert_eq!(Instruction::try_from(11).unwrap(), Instruction::WithdrawSolV4);
        assert_eq!(Instruction::try_from(12).unwrap(), Instruction::WithdrawTokenV4);
        assert_eq!(Instruction::try_from(13).unwrap(), Instruction::ExecuteV4);
        assert_eq!(Instruction::try_from(14).unwrap(), Instruction::ActivateV4);
        assert_eq!(Instruction::try_from(15).unwrap(), Instruction::InitTreasury);
        assert_eq!(Instruction::try_from(16).unwrap(), Instruction::WithdrawRevenue);
        assert_eq!(Instruction::try_from(17).unwrap(), Instruction::AddAdmin);
        assert_eq!(Instruction::try_from(18).unwrap(), Instruction::RemoveAdmin);
        assert!(Instruction::try_from(19).is_err());
    }
}
