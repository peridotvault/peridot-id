//! Smart account state.
//!
//! V1 layout (80 bytes, frozen for reads):
//! `version‖type‖status‖nonce u64LE‖authority[33]‖account_id[32]`
//!
//! V2 layout (112 bytes): the V1 80-byte prefix is intact, then `rp_id_hash[32]`
//! (sha256 of the WebAuthn RP ID) so the program enforces the same RP-ID + UV
//! semantics as the EVM counterpart. Writers always stamp v2; v1 states remain
//! readable but cannot authorize V2 operations (which require an RP-ID hash).

use crate::errors::PeridotError;
use pinocchio::error::ProgramError;

/// V1 state length (frozen, read-only legacy).
pub const STATE_LEN_V1: usize = 80;
/// V2 state length (V1 prefix + 32-byte RP-ID hash).
pub const STATE_LEN_V2: usize = 112;

pub const AUTHORITY_TYPE_ED25519: u8 = 0; // legacy — unused in V1
pub const AUTHORITY_TYPE_SECP256R1: u8 = 1; // passkey authority (ADR 005 Option B)

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_CLOSED: u8 = 1;

/// State version written by V1 creators.
pub const VERSION_V1: u8 = 1;
/// State version written by V2 creators.
pub const VERSION: u8 = 2;

pub const AUTHORITY_LEN: usize = 33; // compressed secp256r1 public key
pub const RP_ID_LEN: usize = 32; // sha256(WebAuthn RP ID)

/// Byte offsets into the account data (shared V1/V2 prefix).
const OFF_VERSION: usize = 0;
const OFF_AUTHORITY_TYPE: usize = 1;
const OFF_STATUS: usize = 2;
const OFF_NONCE: usize = 4; // u64 LE
const OFF_AUTHORITY: usize = 12; // [u8; 33]
const OFF_ACCOUNT_ID: usize = 48; // [u8; 32] (aligned after the 33-byte authority)
/// V2-only: RP-ID hash appended after the V1 prefix.
const OFF_RP_ID: usize = 80; // [u8; 32]

/// Smart account state. Immutable/read-only views borrow the account data.
#[derive(Clone, Copy)]
pub struct SmartAccount<'data> {
    data: &'data [u8],
}

impl<'data> SmartAccount<'data> {
    pub fn try_from_bytes(data: &'data [u8]) -> Result<Self, ProgramError> {
        if data.len() == STATE_LEN_V1 {
            if data[OFF_VERSION] != VERSION_V1 {
                return Err(ProgramError::InvalidAccountData);
            }
            return Ok(Self { data });
        }
        if data.len() == STATE_LEN_V2 {
            if data[OFF_VERSION] != VERSION {
                return Err(ProgramError::InvalidAccountData);
            }
            return Ok(Self { data });
        }
        Err(ProgramError::InvalidAccountData)
    }

    /// True for V2 states (carry an RP-ID hash).
    pub fn is_v2(&self) -> bool {
        self.data.len() == STATE_LEN_V2
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

    /// RP-ID hash. V1 states have none → `MissingRpIdHash` (re-onboard required).
    pub fn rp_id_hash(&self) -> Result<[u8; 32], ProgramError> {
        if self.data.len() != STATE_LEN_V2 {
            return Err(PeridotError::MissingRpIdHash.into());
        }
        Ok(self.data[OFF_RP_ID..OFF_RP_ID + RP_ID_LEN]
            .try_into()
            .expect("slice is 32 bytes"))
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

    pub fn is_initialized(&self) -> bool {
        self.data[OFF_STATUS] != STATUS_CLOSED
    }
}

/// Mutable smart account state — writes into the account data (V2 only).
pub struct SmartAccountMut<'data> {
    data: &'data mut [u8],
}

impl<'data> SmartAccountMut<'data> {
    pub fn try_from_bytes(data: &'data mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != STATE_LEN_V2 {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn initialize(&mut self, account_id: [u8; 32], authority: [u8; 33], rp_id_hash: [u8; 32]) {
        self.data[OFF_VERSION] = VERSION;
        self.data[OFF_AUTHORITY_TYPE] = AUTHORITY_TYPE_SECP256R1;
        self.data[OFF_STATUS] = STATUS_ACTIVE;
        self.data[OFF_NONCE..OFF_NONCE + 8].copy_from_slice(&0u64.to_le_bytes());
        self.data[OFF_AUTHORITY..OFF_AUTHORITY + AUTHORITY_LEN].copy_from_slice(&authority);
        self.data[OFF_ACCOUNT_ID..OFF_ACCOUNT_ID + 32].copy_from_slice(&account_id);
        self.data[OFF_RP_ID..OFF_RP_ID + RP_ID_LEN].copy_from_slice(&rp_id_hash);
    }

    pub fn set_authority(&mut self, authority: [u8; 33]) {
        self.data[OFF_AUTHORITY..OFF_AUTHORITY + AUTHORITY_LEN].copy_from_slice(&authority);
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

/// Verify the smart account PDA against seeds `["peridot_id", "account", account_id]` and
/// return the bump used (needed for CPI signer seeds).
///
/// On host (unit tests) the bpf-gated syscall derivation is unavailable; the real PDA
/// derivation is exercised by the on-chain integration suite (task 005) and the shared
/// vectors in the API (`smart-account.ts`).
pub fn verify_pda(
    smart_account: &pinocchio::AccountView,
    program_id: &pinocchio::Address,
    account_id: [u8; 32],
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected, bump) =
            pinocchio::Address::find_program_address(&[b"peridot_id", b"account", &account_id], program_id);
        if smart_account.address() != &expected {
            return Err(PeridotError::InvalidPda.into());
        }
        Ok(bump)
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (smart_account, program_id, account_id);
        Ok(255)
    }
}

pub fn verify_nonce(account: &SmartAccount, nonce: u64) -> Result<(), ProgramError> {
    if account.nonce() != nonce {
        return Err(PeridotError::InvalidNonce.into());
    }
    Ok(())
}

// ================= Session records (V4 permission layer, ADR-010) =================
//
// A session record lives in its own PDA (`["peridot_id", "session", account_id,
// session_pubkey]`) and authorizes gameplay CPIs signed by that PDA — never the
// vault PDA. The session PDA holds rent-exempt minimum only; lamports safety
// even under signer forwarding follows from the runtime (only THIS program can
// `invoke_signed` for its own PDAs).
//
// Layout (205 bytes, v1):
// `version u8 ‖ status u8 ‖ session_pubkey[32] ‖ account_id[32] ‖ expires_at i64LE ‖
//  last_used i64LE ‖ seq u64LE ‖ allowed_program[32] ‖ recorded_authority[32] ‖
//  recorded_has_authority u8 ‖ recorded_slot u64LE ‖ last_seen_authority[32] ‖
//  last_seen_has_authority u8 ‖ last_seen_slot u64LE ‖ bump u8`
//
// `recorded_*` is the game program's upgrade authority + ProgramData slot,
// verified at registration. `last_seen_*` is refreshed on every execution so
// backend indexers can detect post-trust upgrades (record-and-log: no
// enforcement, ADR-010 §4).

/// Session record length (fixed).
pub const SESSION_STATE_LEN: usize = 205;
/// Session record version.
pub const SESSION_VERSION: u8 = 1;

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

/// Session record. Read-only views borrow the account data.
#[derive(Clone, Copy)]
pub struct SessionAccount<'data> {
    data: &'data [u8],
}

impl<'data> SessionAccount<'data> {
    pub fn try_from_bytes(data: &'data [u8]) -> Result<Self, ProgramError> {
        if data.len() != SESSION_STATE_LEN || data[S_OFF_VERSION] != SESSION_VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
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
}

/// Mutable session record — writes into the account data.
pub struct SessionAccountMut<'data> {
    data: &'data mut [u8],
}

impl<'data> SessionAccountMut<'data> {
    pub fn try_from_bytes(data: &'data mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != SESSION_STATE_LEN {
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
    ) {
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
}

/// Verify the session PDA against seeds
/// `["peridot_id", "session", account_id, session_pubkey]` and return the bump.
pub fn verify_session_pda(
    session: &pinocchio::AccountView,
    program_id: &pinocchio::Address,
    account_id: [u8; 32],
    session_key: [u8; 32],
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected, bump) = pinocchio::Address::find_program_address(
            &[b"peridot_id", b"session", &account_id, &session_key],
            program_id,
        );
        if session.address() != &expected {
            return Err(crate::errors::PeridotError::InvalidPda.into());
        }
        Ok(bump)
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (session, program_id, account_id, session_key);
        Ok(255)
    }
}
