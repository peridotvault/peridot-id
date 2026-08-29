//! Smart account state — a fixed 80-byte layout stored in the PDA.

use crate::errors::PeridotError;
use pinocchio::error::ProgramError;

pub const STATE_LEN: usize = 80;

pub const AUTHORITY_TYPE_ED25519: u8 = 0; // legacy — unused in V1
pub const AUTHORITY_TYPE_SECP256R1: u8 = 1; // passkey authority (ADR 005 Option B)

pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_CLOSED: u8 = 1;

pub const VERSION: u8 = 1;

pub const AUTHORITY_LEN: usize = 33; // compressed secp256r1 public key

/// Byte offsets into the account data.
const OFF_VERSION: usize = 0;
const OFF_AUTHORITY_TYPE: usize = 1;
const OFF_STATUS: usize = 2;
const OFF_NONCE: usize = 4; // u64 LE
const OFF_AUTHORITY: usize = 12; // [u8; 33]
const OFF_ACCOUNT_ID: usize = 48; // [u8; 32] (aligned after the 33-byte authority)

/// Smart account state. Immutable/read-only views borrow the account data.
#[derive(Clone, Copy)]
pub struct SmartAccount<'data> {
    data: &'data [u8],
}

impl<'data> SmartAccount<'data> {
    pub fn try_from_bytes(data: &'data [u8]) -> Result<Self, ProgramError> {
        if data.len() != STATE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[OFF_VERSION] != VERSION {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
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

/// Mutable smart account state — writes into the account data.
pub struct SmartAccountMut<'data> {
    data: &'data mut [u8],
}

impl<'data> SmartAccountMut<'data> {
    pub fn try_from_bytes(data: &'data mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != STATE_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn initialize(&mut self, account_id: [u8; 32], authority: [u8; 33]) {
        self.data[OFF_VERSION] = VERSION;
        self.data[OFF_AUTHORITY_TYPE] = AUTHORITY_TYPE_SECP256R1;
        self.data[OFF_STATUS] = STATUS_ACTIVE;
        self.data[OFF_NONCE..OFF_NONCE + 8].copy_from_slice(&0u64.to_le_bytes());
        self.data[OFF_AUTHORITY..OFF_AUTHORITY + AUTHORITY_LEN].copy_from_slice(&authority);
        self.data[OFF_ACCOUNT_ID..OFF_ACCOUNT_ID + 32].copy_from_slice(&account_id);
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

/// Verify the smart account PDA against seeds `["peridot", "account", account_id]` and
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
            pinocchio::Address::find_program_address(&[b"peridot", b"account", &account_id], program_id);
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