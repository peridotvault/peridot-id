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
    /// Retained for decoder compatibility only (discriminant 11 unchanged).
    /// No longer emitted: ANT-612 removed the creation allowlist, so
    /// creation paths are permissionless (passkey-authorized) and this error
    /// has no producer. Kept so old SDK decoders never misread slot 11.
    Forbidden = 11,
    /// V4 fee-cap family (ANT-544 B5, ANT-556): the attested
    /// `network_fee + protocol_fee` exceeded the user-approved `max_total_fee`.
    /// Reintroduced at the retired slot — discriminant 12 preserved, so old SDK
    /// decoders keep working. V3 verifiers never emit this (no cap was signed).
    FeeExceedsMax = 12,
    /// The fee-policy version is unknown or unsupported.
    UnknownFeePolicy = 13,
    /// A policy percentage exceeds the protocol maximum.
    ExceedsMaxBps = 15,
    /// The CPI target is forbidden (the smart account cannot call itself).
    InvalidTarget = 16,
    /// The session record is missing or malformed.
    SessionNotFound = 17,
    /// The session has been revoked by the owner.
    SessionRevoked = 18,
    /// The session expired (hard expiry) or timed out (inactivity).
    SessionExpired = 19,
    /// The session sequence does not match (replay or skip).
    BadSessionSeq = 20,
    /// A session-authorized call violated its scope (wrong program, vault
    /// passed, protected account changed, or upgrade record unreadable).
    SessionScopeViolation = 21,
    /// The session lifetime exceeds the 24h maximum.
    SessionTtlExceeded = 22,
    /// ANT-16(e) (board fee decision d4ebecff): direct `initialize` is
    /// deprecated — creation must route through `activate` (the sole
    /// fee-bearing sponsored-creation path). Additive-only: existing
    /// discriminants are untouched so old SDK decoders keep working.
    InitializeDeprecated = 23,
    /// C3 session spend bound (ANT-544 C3, ANT-556): a gameplay execution
    /// decreased the session PDA's lamports. The session PDA holds the
    /// rent-exempt minimum only; per-execution net outflow is capped at zero —
    /// a compromised session or hostile game cannot drain session rent/fees.
    /// Additive-only (new discriminant 24).
    SessionSpendExceeded = 24,
}

impl From<PeridotError> for ProgramError {
    fn from(e: PeridotError) -> Self {
        ProgramError::Custom(e as u32)
    }
}