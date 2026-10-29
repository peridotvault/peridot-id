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
    /// ANT-635 revenue vault (ANT-638): signer not in the live config allowlist.
    /// Additive-only (new discriminant 25). Note: spec ANT-637 numbered these
    /// 24-27, but 24 was already taken by `SessionSpendExceeded`, so the vault
    /// family starts at 25.
    NotAdmin = 25,
    /// ANT-635 revenue vault: `InitTreasury` on an already-initialized
    /// config/treasury PDA. Additive-only (new discriminant 26).
    ConfigAlreadyInitialized = 26,
    /// ANT-635 revenue vault: `AddAdmin` at MAX_ADMINS (8). Additive-only
    /// (new discriminant 27).
    TooManyAdmins = 27,
    /// ANT-635 revenue vault: `RemoveAdmin` targeting the last live admin
    /// (floor-1, EVM `PeridotFactory` parity). Additive-only (28).
    CannotRemoveLastAdmin = 28,
    /// ANT-863 B3 rotation/session epoch: the session record's stamped
    /// generation no longer matches the vault epoch (the owner rotated since
    /// registration, implicitly revoking the session). Distinct from
    /// `SessionRevoked` (explicit per-session revoke) so UX/indexers can
    /// tell "rotated, re-register" apart. Additive-only (29).
    SessionStaleGeneration = 29,
    /// ANT-866 B1 tombstone: this `account_id` was closed — a program-owned
    /// tombstone PDA exists, so re-claim (by any key) is rejected. The pid is
    /// never reused or reassigned. Additive-only (30).
    Tombstoned = 30,
    /// ANT-866 B1 grace: the vault is `STATUS_CLOSING` — spend, rotate,
    /// withdraw, and session operations are frozen until `close_cancel`
    /// (revive) or `close_finalize` (payout + tombstone). Additive-only (31).
    AccountClosing = 31,
    /// ANT-866 B1 grace: `close_cancel`/`close_finalize` with no live ticket
    /// for this (account_id, authority). Additive-only (32).
    CloseTicketNotFound = 32,
    /// ANT-866 B1 grace: `close_finalize` before `deadline` (chain clock).
    /// Additive-only (33).
    GraceNotElapsed = 33,
    /// ANT-866 B1: immediate `Close` (discriminant 4) is permanently
    /// disabled — teardown must route through the `close_request` grace flow
    /// (which writes the tombstone). Same shape as `InitializeDeprecated`:
    /// discriminant 4 still decodes, then rejects. Additive-only (34).
    CloseDeprecated = 34,
    /// ANT-866 B1 grace: `close_request` while a ticket is already live for
    /// this (account_id, authority). Cancel or finalize first. Additive-only (35).
    CloseAlreadyRequested = 35,
}

impl From<PeridotError> for ProgramError {
    fn from(e: PeridotError) -> Self {
        ProgramError::Custom(e as u32)
    }
}