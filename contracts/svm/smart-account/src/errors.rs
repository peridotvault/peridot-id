//! Program errors.

use pinocchio::error::ProgramError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum PeridotError {
    /// The smart account is already initialized.
    AlreadyInitialized = 0,
    /// The smart account is not initialized.
    Uninitialized = 1,
    /// The signer is not the registered authority.
    Unauthorized = 2,
    /// The provided nonce does not match the account nonce (replay).
    InvalidNonce = 3,
    /// The PDA does not match the expected seeds.
    InvalidPda = 4,
    /// The authority account is not a signer.
    NotSigner = 5,
    /// The account is not owned by the expected program.
    WrongOwner = 6,
    /// The destination cannot be the smart account itself.
    InvalidDestination = 7,
    /// The smart account does not hold enough SOL.
    InsufficientFunds = 8,
    /// The signature expiry has passed.
    Expired = 9,
    /// The WebAuthn challenge / clientDataJSON binding is invalid.
    InvalidChallenge = 10,
}

impl From<PeridotError> for ProgramError {
    fn from(e: PeridotError) -> Self {
        ProgramError::Custom(e as u32)
    }
}