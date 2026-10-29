//! Smart account state.
//!
//! Single 112-byte layout, V3 since ANT-866 B1 (PID-key binding):
//! `version‖type‖status‖generation‖nonce u64LE‖authority[33]‖account_id[32]‖key_hash[32]`
//!
//! - `key_hash = sha256(authority-at-claim)` is written ONCE by
//!   `activate`/`activate_v4` and NEVER rewritten (rotation only replaces
//!   `authority`): the PDA seeds bind the claiming key while rotation keeps
//!   working, because every operation verifies the PDA against the STORED
//!   hash instead of the current key.
//! - Pre-B1 80-byte states (V1/V2, keyless PDAs) are REJECTED outright
//!   (`InvalidAccountData`): their addresses cannot match the bound
//!   derivation, and no user funds exist to migrate (ANT-863 funding freeze).
//!
//! Historical note: a V2 layout (112 bytes) previously appended `rp_id_hash[32]`
//! (sha256 of the WebAuthn RP ID) after the 80-byte prefix. ANT-197 removed all
//! on-chain domain pinning, so the V2 layout collapsed back to 80 bytes and no
//! `rp_id_hash` is stored or verified anywhere. V3 reuses the 112-byte length
//! for the binding hash — a different field at a different offset with a new
//! version byte, so no decoder can confuse the two.

use crate::errors::PeridotError;
use pinocchio::error::ProgramError;

/// State length (80 bytes, domain-free since ANT-197). LEGACY — V3 writers
/// emit 112 bytes; readers reject 80-byte states (see header).
pub const STATE_LEN_V1: usize = 80;
/// Legacy V2 length (80 bytes). Readers reject; writers never emit.
pub const STATE_LEN_V2: usize = 80;
/// State length written by current creators (112 bytes = 80-byte prefix +
/// 32-byte claim-time key hash).
pub const STATE_LEN_V3: usize = 112;

pub const AUTHORITY_TYPE_ED25519: u8 = 0; // legacy — unused in V1
pub const AUTHORITY_TYPE_SECP256R1: u8 = 1; // passkey owner authority

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_CLOSED: u8 = 1;
/// Vault is inside the close grace window (ANT-866 B1): `close_request`
/// accepted, funds frozen — every spend/rotate/session operation fails
/// `AccountClosing` until `close_cancel` (back to ACTIVE) or
/// `close_finalize` (payout + tombstone). No layout change: the status byte
/// already existed.
pub const STATUS_CLOSING: u8 = 2;

/// State version written by V1 creators.
pub const VERSION_V1: u8 = 1;
/// State version written by V2 creators.
pub const VERSION: u8 = 2;
/// State version written by V3 (bound) creators. Only version accepted.
pub const VERSION_V3: u8 = 3;

pub const AUTHORITY_LEN: usize = 33; // compressed secp256r1 public key

/// Byte offsets into the account data (V3; the 80-byte prefix is layout-
/// identical to V1/V2 so nonce/authority/account_id offsets never moved).
const OFF_VERSION: usize = 0;
const OFF_AUTHORITY_TYPE: usize = 1;
const OFF_STATUS: usize = 2;
// Byte 3 is the session-generation epoch (ANT-863 B3): every authority
// rotation saturates it upward by one and `register_session` stamps the
// current value into each new session record; `session_execute` requires
// record generation == vault generation, so rotation implicitly revokes all
// live sessions. Pre-ANT-863 vaults were created zero-filled (System
// `CreateAccount`) and `initialize` never wrote this byte, so every legacy
// vault reads generation 0 — matching the legacy-session default below.
const OFF_SESSION_GENERATION: usize = 3;
const OFF_NONCE: usize = 4; // u64 LE
const OFF_AUTHORITY: usize = 12; // [u8; 33]
const OFF_ACCOUNT_ID: usize = 48; // [u8; 32] (aligned after the 33-byte authority)
const OFF_KEY_HASH: usize = 80; // [u8; 32] sha256(authority-at-claim), ANT-866 B1

/// Smart account state. Immutable/read-only views borrow the account data.
#[derive(Clone, Copy)]
pub struct SmartAccount<'data> {
    data: &'data [u8],
}

impl<'data> SmartAccount<'data> {
    pub fn try_from_bytes(data: &'data [u8]) -> Result<Self, ProgramError> {
        // V3-only readers (ANT-866 B1): 112 bytes stamped 3. Pre-B1 80-byte
        // states live at keyless PDAs that can never match the bound
        // derivation — fail closed instead of misreading them.
        if data.len() != STATE_LEN_V3 {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[OFF_VERSION] != VERSION_V3 {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    /// True for states stamped with the current version.
    pub fn is_v2(&self) -> bool {
        self.data[OFF_VERSION] == VERSION
    }

    /// True for states stamped with the bound (current) version.
    pub fn is_v3(&self) -> bool {
        self.data[OFF_VERSION] == VERSION_V3
    }

    pub fn authority(&self) -> [u8; 33] {
        self.data[OFF_AUTHORITY..OFF_AUTHORITY + AUTHORITY_LEN]
            .try_into()
            .expect("slice is 33 bytes")
    }

    pub fn account_id(&self) -> [u8; 32] {
        self.data[OFF_ACCOUNT_ID..OFF_ACCOUNT_ID + 32]
            .try_into()
            .expect("slice is 32 bytes")
    }

    /// Claim-time key hash (`sha256(authority-at-claim)`, ANT-866 B1): the
    /// PDA seeds commit to this value, and it NEVER changes — every
    /// operation verifies the PDA against the stored hash, so rotation
    /// (which only replaces `authority`) keeps working.
    pub fn key_hash(&self) -> [u8; 32] {
        self.data[OFF_KEY_HASH..OFF_KEY_HASH + 32]
            .try_into()
            .expect("slice is 32 bytes")
    }

    pub fn authority_type(&self) -> u8 {
        self.data[OFF_AUTHORITY_TYPE]
    }

    pub fn status(&self) -> u8 {
        self.data[OFF_STATUS]
    }

    pub fn nonce(&self) -> u64 {
        u64::from_le_bytes(
            self.data[OFF_NONCE..OFF_NONCE + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        )
    }

    /// Session-generation epoch (ANT-863 B3). Rotation revokes sessions.
    pub fn session_generation(&self) -> u8 {
        self.data[OFF_SESSION_GENERATION]
    }

    pub fn is_initialized(&self) -> bool {
        self.data[OFF_STATUS] != STATUS_CLOSED
    }

    /// Fail closed unless the vault is ACTIVE (ANT-866 B1): spend, rotate,
    /// withdraw, and session operations must not run inside the close grace
    /// window (`STATUS_CLOSING`) — only `close_cancel`/`close_finalize` may.
    /// Pure: host-testable alongside the time check below.
    pub fn require_active(&self) -> Result<(), PeridotError> {
        if self.data[OFF_STATUS] != STATUS_ACTIVE {
            return Err(PeridotError::AccountClosing);
        }
        Ok(())
    }
}

/// Mutable smart account state — writes into the account data (V2 only).
pub struct SmartAccountMut<'data> {
    data: &'data mut [u8],
}

impl<'data> SmartAccountMut<'data> {
    pub fn try_from_bytes(data: &'data mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != STATE_LEN_V3 {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn initialize(&mut self, account_id: [u8; 32], authority: [u8; 33]) {
        self.data[OFF_VERSION] = VERSION_V3;
        self.data[OFF_AUTHORITY_TYPE] = AUTHORITY_TYPE_SECP256R1;
        self.data[OFF_STATUS] = STATUS_ACTIVE;
        self.data[OFF_SESSION_GENERATION] = 0;
        self.data[OFF_NONCE..OFF_NONCE + 8].copy_from_slice(&0u64.to_le_bytes());
        self.data[OFF_AUTHORITY..OFF_AUTHORITY + AUTHORITY_LEN].copy_from_slice(&authority);
        self.data[OFF_ACCOUNT_ID..OFF_ACCOUNT_ID + 32].copy_from_slice(&account_id);
        // Claim-time binding (ANT-866 B1): stamped once, never rewritten.
        self.data[OFF_KEY_HASH..OFF_KEY_HASH + 32].copy_from_slice(&crate::auth::sha256(&authority));
    }

    pub fn set_authority(&mut self, authority: [u8; 33]) {
        self.data[OFF_AUTHORITY..OFF_AUTHORITY + AUTHORITY_LEN].copy_from_slice(&authority);
    }

    /// Flip the lifecycle status (ANT-866 B1 grace: ACTIVE ↔ CLOSING).
    /// Only the close flow writes this; every other path treats any
    /// non-ACTIVE status as frozen via `require_active`.
    pub fn set_status(&mut self, status: u8) {
        self.data[OFF_STATUS] = status;
    }

    /// Bump the session-generation epoch after an authority rotation
    /// (ANT-863 B3). Saturating: at 255 further rotations keep the epoch
    /// instead of wrapping back to 0 (wrapping would revive long-dead
    /// generation-0 sessions; saturation only keeps the current-epoch
    /// sessions alive, and every session still carries its own ≤24h
    /// `expires_at`). Rotation #256+ without a fresh session registry is a
    /// residual accepted by the rotation UX (see `update_authority.rs`).
    pub fn bump_session_generation(&mut self) {
        let current = self.data[OFF_SESSION_GENERATION];
        self.data[OFF_SESSION_GENERATION] = current.saturating_add(1);
    }

    pub fn increment_nonce(&mut self) {
        let current = self.nonce();
        self.data[OFF_NONCE..OFF_NONCE + 8].copy_from_slice(&(current + 1).to_le_bytes());
    }

    pub fn nonce(&self) -> u64 {
        u64::from_le_bytes(
            self.data[OFF_NONCE..OFF_NONCE + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        )
    }

    pub fn authority(&self) -> [u8; 33] {
        self.data[OFF_AUTHORITY..OFF_AUTHORITY + AUTHORITY_LEN]
            .try_into()
            .expect("slice is 33 bytes")
    }
}

/// PID-key binding hash (ANT-866 B1): the 33-byte compressed secp256r1
/// authority does not fit a PDA seed (32-byte max), so vault/session seeds
/// carry `sha256(authority)` via the pure-Rust hasher (no syscall). Pure:
/// host-testable, and the SDK mirrors it byte-for-byte.
pub fn vault_key_hash(authority: &[u8; 33]) -> [u8; 32] {
    crate::auth::sha256(authority)
}

/// Verify the smart account PDA against seeds
/// `["peridot_id", "account", account_id, key_hash]` and return the bump used
/// (needed for CPI signer seeds).
///
/// ANT-866 B1: `key_hash` is the STORED claim-time hash (`state.key_hash()`)
/// for every operation on an existing vault — rotation replaces `authority`
/// but never the hash, so post-rotation operations keep verifying. Only
/// `activate`/`activate_v4` hash the instruction authority (no state exists
/// yet), which is what makes a pre-funded PDA unclaimable by any other key.
///
/// On host (unit tests) the bpf-gated syscall derivation is unavailable; the real PDA
/// derivation is exercised by the on-chain integration suite (task 005) and the shared
/// vectors in the API (`smart-account.ts`).
pub fn verify_pda(
    smart_account: &pinocchio::AccountView,
    program_id: &pinocchio::Address,
    account_id: [u8; 32],
    key_hash: [u8; 32],
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected, bump) = pinocchio::Address::find_program_address(
            &[b"peridot_id", b"account", &account_id, &key_hash],
            program_id,
        );
        if smart_account.address() != &expected {
            return Err(PeridotError::InvalidPda.into());
        }
        Ok(bump)
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (smart_account, program_id, account_id, key_hash);
        Ok(255)
    }
}

pub fn verify_nonce(account: &SmartAccount, nonce: u64) -> Result<(), ProgramError> {
    if account.nonce() != nonce {
        return Err(PeridotError::InvalidNonce.into());
    }
    Ok(())
}

// ================= Session records (WHITEPAPER.md §11) =================
//
// A session record lives in its own PDA (`["peridot_id", "session", account_id,
// sha256(authority), session_pubkey]`, key-bound since ANT-866 B1) and
// authorizes gameplay CPIs signed by that PDA — never the
// vault PDA. The session PDA holds rent-exempt minimum only; lamports safety
// even under signer forwarding follows from the runtime (only THIS program can
// `invoke_signed` for its own PDAs).
//
// Layout (206 bytes, v2 since ANT-863 B3): the v1 205-byte prefix plus a
// trailing `generation u8` (the vault session-generation epoch stamped at
// registration; `update_authority` bumps the vault epoch, so rotation
// implicitly revokes every session stamped with an older epoch).
// Migration: pre-ANT-863 records are 205 bytes (v1, no generation byte).
// `version u8 ‖ status u8 ‖ session_pubkey[32] ‖ account_id[32] ‖ expires_at i64LE ‖
//  last_used i64LE ‖ seq u64LE ‖ allowed_program[32] ‖ recorded_authority[32] ‖
//  recorded_has_authority u8 ‖ recorded_slot u64LE ‖ last_seen_authority[32] ‖
//  last_seen_has_authority u8 ‖ last_seen_slot u64LE ‖ bump u8 ‖ generation u8`
//
// `recorded_*` is the game program's upgrade authority + ProgramData slot,
// verified at registration. `last_seen_*` is refreshed on every execution so
// backend indexers can detect post-trust upgrades (record-and-log: no
// enforcement, WHITEPAPER.md §11).

/// Session record length (fixed, v2 since ANT-863 B3).
pub const SESSION_STATE_LEN: usize = 206;
/// Legacy (pre-ANT-863 B3) session record length — accepted read-only for
/// graceful migration (generation reads as 0).
pub const SESSION_STATE_LEN_V1: usize = 205;
/// Session record version.
pub const SESSION_VERSION: u8 = 2;
/// Legacy session record version (205-byte records).
pub const SESSION_VERSION_V1: u8 = 1;

pub const SESSION_STATUS_ACTIVE: u8 = 0;
pub const SESSION_STATUS_REVOKED: u8 = 1;

const S_OFF_VERSION: usize = 0;
const S_OFF_STATUS: usize = 1;
const S_OFF_SESSION_KEY: usize = 2; // [u8; 32] Ed25519
const S_OFF_ACCOUNT_ID: usize = 34; // [u8; 32]
const S_OFF_EXPIRES_AT: usize = 66; // i64 LE
const S_OFF_LAST_USED: usize = 74; // i64 LE
const S_OFF_SEQ: usize = 82; // u64 LE
const S_OFF_PROGRAM: usize = 90; // [u8; 32]
const S_OFF_REC_AUTH: usize = 122; // [u8; 32]
const S_OFF_REC_HAS_AUTH: usize = 154; // u8
const S_OFF_REC_SLOT: usize = 155; // u64 LE
const S_OFF_SEEN_AUTH: usize = 163; // [u8; 32]
const S_OFF_SEEN_HAS_AUTH: usize = 195; // u8
const S_OFF_SEEN_SLOT: usize = 196; // u64 LE
const S_OFF_BUMP: usize = 204; // u8
const S_OFF_GENERATION: usize = 205; // u8 (v2 only; ANT-863 B3)

/// Session record. Read-only views borrow the account data.
#[derive(Clone, Copy)]
pub struct SessionAccount<'data> {
    data: &'data [u8],
}

impl<'data> SessionAccount<'data> {
    pub fn try_from_bytes(data: &'data [u8]) -> Result<Self, ProgramError> {
        // v2 (206 bytes) is the write format since ANT-863 B3. Legacy v1
        // (205 bytes) records are accepted read-only for graceful migration:
        // rent recovery (`close_session`) and explicit revocation keep
        // working on them; they read generation 0 (see `generation()`), which
        // matches every legacy vault, so they execute normally until the
        // first post-upgrade rotation.
        if data.len() == SESSION_STATE_LEN_V1 {
            if data[S_OFF_VERSION] != SESSION_VERSION_V1 {
                return Err(ProgramError::InvalidAccountData);
            }
        } else if data.len() == SESSION_STATE_LEN {
            if data[S_OFF_VERSION] != SESSION_VERSION {
                return Err(ProgramError::InvalidAccountData);
            }
        } else {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    /// True for records written by the current (v2) `register_session`.
    pub fn is_v2(&self) -> bool {
        self.data.len() == SESSION_STATE_LEN
    }

    pub fn status(&self) -> u8 {
        self.data[S_OFF_STATUS]
    }

    pub fn is_active(&self) -> bool {
        self.data[S_OFF_STATUS] == SESSION_STATUS_ACTIVE
    }

    pub fn session_key(&self) -> [u8; 32] {
        self.data[S_OFF_SESSION_KEY..S_OFF_SESSION_KEY + 32]
            .try_into()
            .expect("slice is 32 bytes")
    }

    pub fn account_id(&self) -> [u8; 32] {
        self.data[S_OFF_ACCOUNT_ID..S_OFF_ACCOUNT_ID + 32]
            .try_into()
            .expect("slice is 32 bytes")
    }

    pub fn expires_at(&self) -> i64 {
        i64::from_le_bytes(
            self.data[S_OFF_EXPIRES_AT..S_OFF_EXPIRES_AT + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        )
    }

    pub fn last_used(&self) -> i64 {
        i64::from_le_bytes(
            self.data[S_OFF_LAST_USED..S_OFF_LAST_USED + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        )
    }

    pub fn seq(&self) -> u64 {
        u64::from_le_bytes(
            self.data[S_OFF_SEQ..S_OFF_SEQ + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        )
    }

    pub fn allowed_program(&self) -> [u8; 32] {
        self.data[S_OFF_PROGRAM..S_OFF_PROGRAM + 32]
            .try_into()
            .expect("slice is 32 bytes")
    }

    pub fn recorded_authority(&self) -> ([u8; 32], bool) {
        (
            self.data[S_OFF_REC_AUTH..S_OFF_REC_AUTH + 32]
                .try_into()
                .expect("slice is 32 bytes"),
            self.data[S_OFF_REC_HAS_AUTH] != 0,
        )
    }

    pub fn recorded_slot(&self) -> u64 {
        u64::from_le_bytes(
            self.data[S_OFF_REC_SLOT..S_OFF_REC_SLOT + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        )
    }

    /// Session-generation epoch stamped at registration (ANT-863 B3).
    /// Legacy v1 records (205 bytes) predate the epoch and read 0.
    pub fn generation(&self) -> u8 {
        if self.data.len() == SESSION_STATE_LEN {
            self.data[S_OFF_GENERATION]
        } else {
            0
        }
    }
}

/// Mutable session record — writes into the account data.
pub struct SessionAccountMut<'data> {
    data: &'data mut [u8],
}

impl<'data> SessionAccountMut<'data> {
    pub fn try_from_bytes(data: &'data mut [u8]) -> Result<Self, ProgramError> {
        // Writers accept both layouts (see the read-side migration note):
        // `revoke`/`advance`/`record_seen` only touch the shared 205-byte
        // prefix. `initialize` additionally requires the v2 length — it
        // stamps the generation byte.
        if data.len() != SESSION_STATE_LEN && data.len() != SESSION_STATE_LEN_V1 {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn initialize(
        &mut self,
        session_key: [u8; 32],
        account_id: [u8; 32],
        expires_at: i64,
        now: i64,
        allowed_program: [u8; 32],
        recorded_authority: [u8; 32],
        recorded_has_authority: bool,
        recorded_slot: u64,
        bump: u8,
        generation: u8,
    ) -> Result<(), ProgramError> {
        if self.data.len() != SESSION_STATE_LEN {
            // Unreachable in-program (`register_session` creates exactly
            // `SESSION_STATE_LEN` bytes), but fail closed rather than writing
            // the generation byte out of bounds on a legacy record.
            return Err(ProgramError::InvalidAccountData);
        }
        self.data[S_OFF_VERSION] = SESSION_VERSION;
        self.data[S_OFF_STATUS] = SESSION_STATUS_ACTIVE;
        self.data[S_OFF_SESSION_KEY..S_OFF_SESSION_KEY + 32].copy_from_slice(&session_key);
        self.data[S_OFF_ACCOUNT_ID..S_OFF_ACCOUNT_ID + 32].copy_from_slice(&account_id);
        self.data[S_OFF_EXPIRES_AT..S_OFF_EXPIRES_AT + 8].copy_from_slice(&expires_at.to_le_bytes());
        self.data[S_OFF_LAST_USED..S_OFF_LAST_USED + 8].copy_from_slice(&now.to_le_bytes());
        self.data[S_OFF_SEQ..S_OFF_SEQ + 8].copy_from_slice(&0u64.to_le_bytes());
        self.data[S_OFF_PROGRAM..S_OFF_PROGRAM + 32].copy_from_slice(&allowed_program);
        self.data[S_OFF_REC_AUTH..S_OFF_REC_AUTH + 32].copy_from_slice(&recorded_authority);
        self.data[S_OFF_REC_HAS_AUTH] = u8::from(recorded_has_authority);
        self.data[S_OFF_REC_SLOT..S_OFF_REC_SLOT + 8].copy_from_slice(&recorded_slot.to_le_bytes());
        // last_seen_* starts as the registration snapshot.
        self.data[S_OFF_SEEN_AUTH..S_OFF_SEEN_AUTH + 32].copy_from_slice(&recorded_authority);
        self.data[S_OFF_SEEN_HAS_AUTH] = u8::from(recorded_has_authority);
        self.data[S_OFF_SEEN_SLOT..S_OFF_SEEN_SLOT + 8].copy_from_slice(&recorded_slot.to_le_bytes());
        self.data[S_OFF_BUMP] = bump;
        self.data[S_OFF_GENERATION] = generation;
        Ok(())
    }

    pub fn revoke(&mut self) {
        self.data[S_OFF_STATUS] = SESSION_STATUS_REVOKED;
    }

    pub fn advance(&mut self, now: i64) {
        let seq = u64::from_le_bytes(
            self.data[S_OFF_SEQ..S_OFF_SEQ + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        );
        self.data[S_OFF_SEQ..S_OFF_SEQ + 8].copy_from_slice(&(seq + 1).to_le_bytes());
        self.data[S_OFF_LAST_USED..S_OFF_LAST_USED + 8].copy_from_slice(&now.to_le_bytes());
    }

    pub fn record_seen(&mut self, authority: [u8; 32], has_authority: bool, slot: u64) {
        self.data[S_OFF_SEEN_AUTH..S_OFF_SEEN_AUTH + 32].copy_from_slice(&authority);
        self.data[S_OFF_SEEN_HAS_AUTH] = u8::from(has_authority);
        self.data[S_OFF_SEEN_SLOT..S_OFF_SEEN_SLOT + 8].copy_from_slice(&slot.to_le_bytes());
    }
}

/// Pure session-generation check against the vault epoch (ANT-863 B3).
/// Host-testable: rotation revokes sessions without touching PDAs.
/// A stale epoch fails closed as `SessionStaleGeneration` — distinct from
/// `SessionRevoked` (explicit per-session revoke) so indexers and UX can tell
/// "rotated, re-register" apart from "owner revoked this session".
pub fn check_session_generation(
    record_generation: u8,
    vault_generation: u8,
) -> Result<(), crate::errors::PeridotError> {
    if record_generation != vault_generation {
        return Err(crate::errors::PeridotError::SessionStaleGeneration);
    }
    Ok(())
}
/// Pure session-liveness check against the chain clock `now`: hard expiry plus
/// inactivity window. Host-testable (the validator clock cannot be warped, so
/// the live suite covers expiry with a short TTL and revocation directly).
/// Both bounds fail closed as `SessionExpired`.
pub fn check_session_time(expires_at: i64, last_used: i64, now: i64) -> Result<(), crate::errors::PeridotError> {
    if now > expires_at {
        return Err(crate::errors::PeridotError::SessionExpired);
    }
    if now - last_used > crate::auth::SESSION_INACTIVITY_SECS {
        return Err(crate::errors::PeridotError::SessionExpired);
    }
    Ok(())
}

#[cfg(test)]
mod session_time_tests {
    use super::*;

    #[test]
    fn usable_inside_window() {
        assert!(check_session_time(2000, 1000, 1500).is_ok());
    }

    #[test]
    fn expired_at_hard_expiry() {
        assert!(check_session_time(2000, 1999, 2001).is_err());
    }

    #[test]
    fn inactive_session_rejected() {
        // last_used 1801s ago with a live hard expiry still fails.
        assert!(check_session_time(10_000, 1000, 1000 + 1801).is_err());
    }

    #[test]
    fn inactivity_boundary_is_inclusive() {
        // Exactly 1800s idle still passes (`>` comparison, fail-open nowhere).
        assert!(check_session_time(10_000, 1000, 1000 + 1800).is_ok());
    }

    #[test]
    fn advance_and_record_seen_mutate_record_bytes() {
        // F1 (ANT-30) load-bearing lemma: the effects write changes the
        // session record bytes, so a snapshot taken BEFORE `advance` can
        // never equal the post-CPI state when the session PDA itself is
        // protected (rent-pinning) — the post-CPI invariant would always
        // fail closed with `SessionScopeViolation` (0x15). The snapshot must
        // therefore be taken after the write (pinned by
        // `session_execute_snapshots_after_seq_advance` in lib.rs).
        let mut bytes = [0u8; SESSION_STATE_LEN];
        {
            let mut record = SessionAccountMut::try_from_bytes(&mut bytes).unwrap();
            record
                .initialize(
                    [1u8; 32],
                    [2u8; 32],
                    9_999_999_999,
                    1_700_000_000,
                    [3u8; 32],
                    [4u8; 32],
                    true,
                    7,
                    255,
                    0,
                )
                .unwrap();
        }
        let before = crate::auth::sha256(&bytes);
        {
            let mut record = SessionAccountMut::try_from_bytes(&mut bytes).unwrap();
            record.advance(1_700_000_001);
            record.record_seen([5u8; 32], false, 8);
        }
        let after = crate::auth::sha256(&bytes);
        assert_ne!(
            before, after,
            "effects write must change the snapshotted bytes"
        );
        let record = SessionAccount::try_from_bytes(&bytes).unwrap();
        assert_eq!(record.seq(), 1);
    }

    #[test]
    fn initialize_requires_v2_length() {
        // `initialize` stamps the generation byte: a legacy-size buffer must
        // fail closed rather than write out of bounds.
        let mut legacy = [0u8; SESSION_STATE_LEN_V1];
        {
            let mut record = SessionAccountMut::try_from_bytes(&mut legacy).unwrap();
            assert!(record
                .initialize(
                    [1u8; 32],
                    [2u8; 32],
                    9_999_999_999,
                    1_700_000_000,
                    [3u8; 32],
                    [4u8; 32],
                    true,
                    7,
                    255,
                    0,
                )
                .is_err());
        }
    }
}

#[cfg(test)]
mod session_generation_tests {
    use super::*;

    fn init_vault_bytes(generation: u8) -> [u8; STATE_LEN_V3] {
        let mut bytes = [0u8; STATE_LEN_V3];
        {
            let mut vault = SmartAccountMut::try_from_bytes(&mut bytes).unwrap();
            vault.initialize([9u8; 32], [7u8; 33]);
            for _ in 0..generation {
                vault.bump_session_generation();
            }
        }
        bytes
    }

    fn init_session_bytes(generation: u8) -> [u8; SESSION_STATE_LEN] {
        let mut bytes = [0u8; SESSION_STATE_LEN];
        {
            let mut record = SessionAccountMut::try_from_bytes(&mut bytes).unwrap();
            record
                .initialize(
                    [1u8; 32],
                    [2u8; 32],
                    9_999_999_999,
                    1_700_000_000,
                    [3u8; 32],
                    [4u8; 32],
                    true,
                    7,
                    255,
                    generation,
                )
                .unwrap();
        }
        bytes
    }

    #[test]
    fn fresh_vault_starts_at_generation_zero() {
        // initialize() zeroes the epoch byte even on a dirty buffer: legacy
        // vaults (byte 3 never written pre-ANT-863) and fresh vaults agree.
        let mut bytes = [0xAAu8; STATE_LEN_V3];
        {
            let mut vault = SmartAccountMut::try_from_bytes(&mut bytes).unwrap();
            vault.initialize([9u8; 32], [7u8; 33]);
        }
        let vault = SmartAccount::try_from_bytes(&bytes).unwrap();
        assert_eq!(vault.session_generation(), 0);
    }

    #[test]
    fn rotation_bumps_epoch_and_stales_old_sessions() {
        // B3 core property: one rotation invalidates every live session.
        let mut vault_bytes = init_vault_bytes(0);
        let session_bytes = init_session_bytes(0);
        let session = SessionAccount::try_from_bytes(&session_bytes).unwrap();
        let vault = SmartAccount::try_from_bytes(&vault_bytes).unwrap();
        assert!(check_session_generation(session.generation(), vault.session_generation()).is_ok());

        {
            let mut vault_mut = SmartAccountMut::try_from_bytes(&mut vault_bytes).unwrap();
            vault_mut.bump_session_generation();
        }
        let vault = SmartAccount::try_from_bytes(&vault_bytes).unwrap();
        assert_eq!(vault.session_generation(), 1);
        assert_eq!(
            check_session_generation(session.generation(), vault.session_generation()),
            Err(crate::errors::PeridotError::SessionStaleGeneration)
        );
    }

    #[test]
    fn epoch_saturates_instead_of_wrapping() {
        // 255 saturates: wrapping to 0 would revive long-dead generation-0
        // sessions, which is strictly worse than keeping the current epoch
        // alive (every session still carries its own ≤24h `expires_at`).
        let mut bytes = init_vault_bytes(0);
        {
            let mut vault = SmartAccountMut::try_from_bytes(&mut bytes).unwrap();
            for _ in 0..300 {
                vault.bump_session_generation();
            }
        }
        let vault = SmartAccount::try_from_bytes(&bytes).unwrap();
        assert_eq!(vault.session_generation(), 255);
    }

    #[test]
    fn legacy_v1_record_reads_generation_zero() {
        // A 205-byte v1 record (version 1) parses and reports generation 0,
        // so pre-upgrade sessions execute normally until first rotation.
        let mut bytes = [0u8; SESSION_STATE_LEN_V1];
        bytes[S_OFF_VERSION] = SESSION_VERSION_V1;
        let record = SessionAccount::try_from_bytes(&bytes).unwrap();
        assert!(!record.is_v2());
        assert_eq!(record.generation(), 0);
        // ...while a v2 record stamped at epoch 3 reports 3.
        let v2 = init_session_bytes(3);
        let record = SessionAccount::try_from_bytes(&v2).unwrap();
        assert!(record.is_v2());
        assert_eq!(record.generation(), 3);
        assert!(check_session_generation(3, 3).is_ok());
        assert_eq!(
            check_session_generation(0, 3),
            Err(crate::errors::PeridotError::SessionStaleGeneration)
        );
    }

    #[test]
    fn mismatched_version_and_length_rejected() {
        // Cross combos fail closed: v1 length stamped v2, v2 length stamped v1.
        let mut v1_len_v2_ver = [0u8; SESSION_STATE_LEN_V1];
        v1_len_v2_ver[S_OFF_VERSION] = SESSION_VERSION;
        assert!(SessionAccount::try_from_bytes(&v1_len_v2_ver).is_err());

        let mut v2_len_v1_ver = [0u8; SESSION_STATE_LEN];
        v2_len_v1_ver[S_OFF_VERSION] = SESSION_VERSION_V1;
        assert!(SessionAccount::try_from_bytes(&v2_len_v1_ver).is_err());

        assert!(SessionAccount::try_from_bytes(&[0u8; 100]).is_err());
    }
}

/// Verify the session PDA against seeds
/// `["peridot_id", "session", account_id, key_hash, session_pubkey]`
/// and return the bump.
///
/// ANT-866 B1: the vault's STORED key hash keeps sessions inside their own
/// vault — two vaults for one pid (different claiming keys) have disjoint
/// session namespaces, so a session granted under one key is unusable from
/// another vault even though both share the `account_id`.
pub fn verify_session_pda(
    session: &pinocchio::AccountView,
    program_id: &pinocchio::Address,
    account_id: [u8; 32],
    key_hash: [u8; 32],
    session_key: [u8; 32],
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected, bump) = pinocchio::Address::find_program_address(
            &[b"peridot_id", b"session", &account_id, &key_hash, &session_key],
            program_id,
        );
        if session.address() != &expected {
            return Err(crate::errors::PeridotError::InvalidPda.into());
        }
        Ok(bump)
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (session, program_id, account_id, key_hash, session_key);
        Ok(255)
    }
}

// ================= Close ticket + tombstone (ANT-866 B1) =================
//
// Immediate close is gone (discriminant 4 decodes, then rejects with
// `CloseDeprecated`): teardown is a two-phase flow with an unclaim grace
// window, and every closed pid leaves a permanent tombstone.
//
// - `close_request` (owner-signed): creates the ticket PDA
//   `["peridot_id", "close", account_id, sha256(authority)]` (107 bytes,
//   submitter-funded), flips the vault to `STATUS_CLOSING` (all spend/rotate/
//   session ops fail `AccountClosing`), consumes the owner nonce.
// - `close_cancel` (owner-signed): refunds the ticket rent into the vault,
//   deletes the ticket, revives the vault to ACTIVE, consumes the nonce.
// - `close_finalize` (permissionless, after `CLOSE_GRACE_SECS`): writes the
//   tombstone PDA `["peridot_id", "tombstone", account_id]` (74 bytes,
//   submitter-funded, keyed by `account_id` ONLY so it blocks re-claim by any
//   key), pays the full vault balance to the ticket destination, deletes the
//   vault, refunds the ticket rent to the destination.
// - `activate`/`activate_v4` reject when the tombstone exists (`Tombstoned`).
//
// Rent discipline: ticket + tombstone rents are fronted by the submitter
// (like activation rent), never carved from the vault — a dust vault can
// still enter grace, and finalize always pays the FULL vault balance out.

/// Seconds an owner has to cancel an accidental close (7 days). Expiry uses
/// the chain clock (`Clock` sysvar); host tests cover the pure comparison
/// (`check_close_mature`) since the validator clock cannot be warped.
pub const CLOSE_GRACE_SECS: i64 = 604_800;

/// Close-ticket version + length (107 bytes).
pub const TICKET_VERSION: u8 = 1;
pub const TICKET_LEN: usize = 107;
const T_OFF_VERSION: usize = 0;
const T_OFF_ACCOUNT_ID: usize = 1; // [u8; 32]
const T_OFF_AUTHORITY: usize = 33; // [u8; 33]
const T_OFF_DESTINATION: usize = 66; // [u8; 32]
const T_OFF_DEADLINE: usize = 98; // i64 LE (unix_timestamp past which finalize opens)
const T_OFF_BUMP: usize = 106; // u8

/// Tombstone version + length (74 bytes, permanent).
pub const TOMBSTONE_VERSION: u8 = 1;
pub const TOMBSTONE_LEN: usize = 74;
const TS_OFF_VERSION: usize = 0;
const TS_OFF_ACCOUNT_ID: usize = 1; // [u8; 32]
const TS_OFF_AUTHORITY: usize = 33; // [u8; 33] (original claiming key, informational)
const TS_OFF_CLOSED_SLOT: usize = 66; // u64 LE

/// Pure grace comparison: finalize opens at/after `deadline`. Host-testable
/// (the validator clock cannot be warped, so the live suite covers expiry
/// with premature-finalize rejection instead).
pub fn check_close_mature(deadline: i64, now: i64) -> Result<(), crate::errors::PeridotError> {
    if now < deadline {
        return Err(crate::errors::PeridotError::GraceNotElapsed);
    }
    Ok(())
}

/// Close ticket. Read-only views borrow the account data.
#[derive(Clone, Copy)]
pub struct CloseTicket<'data> {
    data: &'data [u8],
}

impl<'data> CloseTicket<'data> {
    pub fn try_from_bytes(data: &'data [u8]) -> Result<Self, ProgramError> {
        if data.len() != TICKET_LEN || data[T_OFF_VERSION] != TICKET_VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn account_id(&self) -> [u8; 32] {
        self.data[T_OFF_ACCOUNT_ID..T_OFF_ACCOUNT_ID + 32]
            .try_into()
            .expect("slice is 32 bytes")
    }

    pub fn authority(&self) -> [u8; 33] {
        self.data[T_OFF_AUTHORITY..T_OFF_AUTHORITY + AUTHORITY_LEN]
            .try_into()
            .expect("slice is 33 bytes")
    }

    pub fn destination(&self) -> [u8; 32] {
        self.data[T_OFF_DESTINATION..T_OFF_DESTINATION + 32]
            .try_into()
            .expect("slice is 32 bytes")
    }

    pub fn deadline(&self) -> i64 {
        i64::from_le_bytes(
            self.data[T_OFF_DEADLINE..T_OFF_DEADLINE + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        )
    }

    pub fn bump(&self) -> u8 {
        self.data[T_OFF_BUMP]
    }
}

/// Mutable close ticket — writes into the account data.
pub struct CloseTicketMut<'data> {
    data: &'data mut [u8],
}

impl<'data> CloseTicketMut<'data> {
    pub fn try_from_bytes(data: &'data mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != TICKET_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn initialize(
        &mut self,
        account_id: [u8; 32],
        authority: [u8; 33],
        destination: [u8; 32],
        deadline: i64,
        bump: u8,
    ) {
        self.data[T_OFF_VERSION] = TICKET_VERSION;
        self.data[T_OFF_ACCOUNT_ID..T_OFF_ACCOUNT_ID + 32].copy_from_slice(&account_id);
        self.data[T_OFF_AUTHORITY..T_OFF_AUTHORITY + AUTHORITY_LEN].copy_from_slice(&authority);
        self.data[T_OFF_DESTINATION..T_OFF_DESTINATION + 32].copy_from_slice(&destination);
        self.data[T_OFF_DEADLINE..T_OFF_DEADLINE + 8].copy_from_slice(&deadline.to_le_bytes());
        self.data[T_OFF_BUMP] = bump;
    }
}

/// Tombstone. Read-only views borrow the account data (never mutated after
/// creation — the account is never closed, so the pid stays tombstoned).
#[derive(Clone, Copy)]
pub struct Tombstone<'data> {
    data: &'data [u8],
}

impl<'data> Tombstone<'data> {
    pub fn try_from_bytes(data: &'data [u8]) -> Result<Self, ProgramError> {
        if data.len() != TOMBSTONE_LEN || data[TS_OFF_VERSION] != TOMBSTONE_VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn account_id(&self) -> [u8; 32] {
        self.data[TS_OFF_ACCOUNT_ID..TS_OFF_ACCOUNT_ID + 32]
            .try_into()
            .expect("slice is 32 bytes")
    }

    pub fn authority(&self) -> [u8; 33] {
        self.data[TS_OFF_AUTHORITY..TS_OFF_AUTHORITY + AUTHORITY_LEN]
            .try_into()
            .expect("slice is 33 bytes")
    }

    pub fn closed_slot(&self) -> u64 {
        u64::from_le_bytes(
            self.data[TS_OFF_CLOSED_SLOT..TS_OFF_CLOSED_SLOT + 8]
                .try_into()
                .expect("slice is 8 bytes"),
        )
    }
}

/// Mutable tombstone — writes into the account data (creation only).
pub struct TombstoneMut<'data> {
    data: &'data mut [u8],
}

impl<'data> TombstoneMut<'data> {
    pub fn try_from_bytes(data: &'data mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != TOMBSTONE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn initialize(&mut self, account_id: [u8; 32], authority: [u8; 33], closed_slot: u64) {
        self.data[TS_OFF_VERSION] = TOMBSTONE_VERSION;
        self.data[TS_OFF_ACCOUNT_ID..TS_OFF_ACCOUNT_ID + 32].copy_from_slice(&account_id);
        self.data[TS_OFF_AUTHORITY..TS_OFF_AUTHORITY + AUTHORITY_LEN].copy_from_slice(&authority);
        self.data[TS_OFF_CLOSED_SLOT..TS_OFF_CLOSED_SLOT + 8].copy_from_slice(&closed_slot.to_le_bytes());
    }
}

/// Verify the close-ticket PDA against seeds
/// `["peridot_id", "close", account_id, key_hash]` and return the bump.
/// `key_hash` is the vault's STORED hash (stable across the grace window —
/// rotation is frozen while CLOSING, so it always matches the ticket).
pub fn verify_ticket_pda(
    ticket: &pinocchio::AccountView,
    program_id: &pinocchio::Address,
    account_id: [u8; 32],
    key_hash: [u8; 32],
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected, bump) = pinocchio::Address::find_program_address(
            &[b"peridot_id", b"close", &account_id, &key_hash],
            program_id,
        );
        if ticket.address() != &expected {
            return Err(crate::errors::PeridotError::InvalidPda.into());
        }
        Ok(bump)
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (ticket, program_id, account_id, key_hash);
        Ok(255)
    }
}

/// Verify the tombstone PDA derivation (`["peridot_id", "tombstone",
/// account_id]`, keyed by pid ONLY) and require it ABSENT: a program-owned
/// tombstone means this pid was closed — re-claim is rejected (`Tombstoned`).
/// Returns the canonical bump (needed to create the tombstone at finalize).
/// Pass the (possibly uninitialized) tombstone account; an empty/system
/// account passes, an initialized one fails. Host stub: derivation is
/// bpf-gated, but emptiness is host-readable, so the host path enforces the
/// emptiness half (fail-closed where it can check).
pub fn verify_tombstone_absent(
    tombstone: &pinocchio::AccountView,
    program_id: &pinocchio::Address,
    account_id: [u8; 32],
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    let bump = {
        let (expected, bump) = pinocchio::Address::find_program_address(
            &[b"peridot_id", b"tombstone", &account_id],
            program_id,
        );
        if tombstone.address() != &expected {
            return Err(crate::errors::PeridotError::InvalidPda.into());
        }
        bump
    };
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    let bump = {
        let _ = (program_id, account_id);
        255
    };
    if tombstone.data_len() != 0 || tombstone.owned_by(program_id) {
        return Err(crate::errors::PeridotError::Tombstoned.into());
    }
    Ok(bump)
}

#[cfg(test)]
mod ant866_close_flow_tests {
    use super::*;

    fn vault_bytes(status: u8) -> [u8; STATE_LEN_V3] {
        let mut b = [0u8; STATE_LEN_V3];
        b[OFF_VERSION] = VERSION_V3;
        b[OFF_AUTHORITY_TYPE] = AUTHORITY_TYPE_SECP256R1;
        b[OFF_STATUS] = status;
        b[OFF_NONCE..OFF_NONCE + 8].copy_from_slice(&7u64.to_le_bytes());
        b[OFF_AUTHORITY..OFF_AUTHORITY + AUTHORITY_LEN].copy_from_slice(&[9u8; 33]);
        b[OFF_ACCOUNT_ID..OFF_ACCOUNT_ID + 32].copy_from_slice(&[3u8; 32]);
        b[OFF_KEY_HASH..OFF_KEY_HASH + 32].copy_from_slice(&vault_key_hash(&[9u8; 33]));
        b
    }

    #[test]
    fn require_active_passes_only_for_active() {
        let active = vault_bytes(STATUS_ACTIVE);
        let view = SmartAccount::try_from_bytes(&active).unwrap();
        assert!(view.require_active().is_ok());

        let closing = vault_bytes(STATUS_CLOSING);
        let view = SmartAccount::try_from_bytes(&closing).unwrap();
        assert_eq!(view.require_active(), Err(PeridotError::AccountClosing));

        let closed = vault_bytes(STATUS_CLOSED);
        let view = SmartAccount::try_from_bytes(&closed).unwrap();
        assert_eq!(view.require_active(), Err(PeridotError::AccountClosing));
    }

    #[test]
    fn close_mature_opens_at_deadline() {
        assert_eq!(check_close_mature(1000, 999), Err(PeridotError::GraceNotElapsed));
        assert!(check_close_mature(1000, 1000).is_ok());
        assert!(check_close_mature(1000, 1001).is_ok());
    }

    #[test]
    fn closing_status_and_grace_constants_pinned() {
        assert_eq!(STATUS_CLOSING, 2);
        assert_eq!(CLOSE_GRACE_SECS, 604_800);
        assert_eq!(TICKET_LEN, 107);
        assert_eq!(TOMBSTONE_LEN, 74);
    }

    #[test]
    fn key_hash_is_deterministic_and_keyed() {
        let a = [1u8; 33];
        let b = [2u8; 33];
        assert_eq!(vault_key_hash(&a), vault_key_hash(&a));
        assert_ne!(vault_key_hash(&a), vault_key_hash(&b));
        // sha256 preimage binding: differs from the raw authority bytes.
        assert_ne!(&vault_key_hash(&a)[..], &a[..32]);
    }

    #[test]
    fn ticket_codec_roundtrip() {
        let mut bytes = [0u8; TICKET_LEN];
        {
            let mut t = CloseTicketMut::try_from_bytes(&mut bytes).unwrap();
            t.initialize([3u8; 32], [9u8; 33], [7u8; 32], 1_800_000_000, 255);
        }
        let view = CloseTicket::try_from_bytes(&bytes).unwrap();
        assert_eq!(view.account_id(), [3u8; 32]);
        assert_eq!(view.authority(), [9u8; 33]);
        assert_eq!(view.destination(), [7u8; 32]);
        assert_eq!(view.deadline(), 1_800_000_000);
        assert_eq!(view.bump(), 255);
        // Wrong length / version rejected.
        assert!(CloseTicket::try_from_bytes(&bytes[..100]).is_err());
        let mut bad = bytes;
        bad[T_OFF_VERSION] = 9;
        assert!(CloseTicket::try_from_bytes(&bad).is_err());
    }

    #[test]
    fn tombstone_codec_roundtrip() {
        let mut bytes = [0u8; TOMBSTONE_LEN];
        {
            let mut t = TombstoneMut::try_from_bytes(&mut bytes).unwrap();
            t.initialize([3u8; 32], [9u8; 33], 42);
        }
        let view = Tombstone::try_from_bytes(&bytes).unwrap();
        assert_eq!(view.account_id(), [3u8; 32]);
        assert_eq!(view.authority(), [9u8; 33]);
        assert_eq!(view.closed_slot(), 42);
        assert!(Tombstone::try_from_bytes(&bytes[..70]).is_err());
    }

    #[test]
    fn set_status_flips_lifecycle() {
        let mut bytes = vault_bytes(STATUS_ACTIVE);
        {
            let mut state = SmartAccountMut::try_from_bytes(&mut bytes).unwrap();
            state.set_status(STATUS_CLOSING);
        }
        let view = SmartAccount::try_from_bytes(&bytes).unwrap();
        assert_eq!(view.status(), STATUS_CLOSING);
        assert_eq!(view.require_active(), Err(PeridotError::AccountClosing));
    }
}
