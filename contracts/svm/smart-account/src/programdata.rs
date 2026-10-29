//! Upgradeable-loader and token-account parsing for the session layer (WHITEPAPER.md §11).
//!
//! All addresses below are system constants — verified end-to-end by the
//! integration suite (registration passes a chain-read ProgramData account and
//! real token accounts; wrong bytes fail closed, never open).

use crate::errors::PeridotError;
use pinocchio::error::ProgramError;

/// BPF upgradeable loader (`BPFLoaderUpgradeab1e11111111111111111111111`).
pub const BPF_LOADER_UPGRADEABLE_ID: [u8; 32] = [
    0x02, 0xa8, 0xf6, 0x91, 0x4e, 0x88, 0xa1, 0xb0, 0xe2, 0x10, 0x15, 0x3e, 0xf7, 0x63, 0xae, 0x2b, 0x00,
    0xc2, 0xb9, 0x3d, 0x16, 0xc1, 0x24, 0xd2, 0xc0, 0x53, 0x7a, 0x10, 0x04, 0x80, 0x00, 0x00,
];

/// SPL Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).
pub const TOKEN_PROGRAM_ID: [u8; 32] = [
    0x06, 0xdd, 0xf6, 0xe1, 0xd7, 0x65, 0xa1, 0x93, 0xd9, 0xcb, 0xe1, 0x46, 0xce, 0xeb, 0x79, 0xac,
    0x1c, 0xb4, 0x85, 0xed, 0x5f, 0x5b, 0x37, 0x91, 0x3a, 0x8c, 0xf5, 0x85, 0x7e, 0xff, 0x00, 0xa9,
];

/// Token-2022 program (`TokenzQdBNbLqP5VEhdkAS6VTFLrWEZ5oFwLVbFW`).
pub const TOKEN_2022_PROGRAM_ID: [u8; 32] = [
    0x00, 0x00, 0x02, 0x4e, 0x7b, 0x2b, 0x3b, 0xb3, 0x7a, 0xe6, 0xc4, 0x44, 0x6f, 0x37, 0x9b, 0x1f,
    0xc5, 0x2b, 0xa4, 0x64, 0x4f, 0xf4, 0xbb, 0xa3, 0x8b, 0xc2, 0x28, 0xe2, 0x92, 0x30, 0x10, 0xe1,
];

/// Deprecated BPF loader (`BPFLoader2111111111111111111111111111111111`).
/// Programs under it are finalized: immutable, no ProgramData account.
pub const BPF_LOADER_DEPRECATED_ID: [u8; 32] = [
    0x02, 0xa8, 0xf6, 0x91, 0x4e, 0x88, 0xa1, 0x6e, 0x39, 0x5a, 0xe1, 0x28, 0x94, 0x8f, 0xfa, 0x69,
    0x56, 0x93, 0x37, 0x68, 0x18, 0xdd, 0x47, 0x43, 0x52, 0x21, 0xf3, 0xc6, 0x00, 0x00, 0x00, 0x00,
];

/// Native loader (`11111111111111111111111111111111`, 32 zero bytes).
/// Native programs (system, vote, config, …) are immutable by construction.
pub const NATIVE_LOADER_ID: [u8; 32] = [0u8; 32];

/// Loader class of a program account: only the upgradeable class carries a
/// ProgramData upgrade record; the other two are immutable by construction.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LoaderClass {
    Upgradeable,
    ImmutableNative,
    ImmutableDeprecated,
    Unknown,
}

/// Classify a program by its owner's loader. Unknown loaders fail closed.
pub fn classify_loader(owner: &[u8; 32]) -> LoaderClass {
    if owner == &BPF_LOADER_UPGRADEABLE_ID {
        LoaderClass::Upgradeable
    } else if owner == &NATIVE_LOADER_ID {
        LoaderClass::ImmutableNative
    } else if owner == &BPF_LOADER_DEPRECATED_ID {
        LoaderClass::ImmutableDeprecated
    } else {
        LoaderClass::Unknown
    }
}

/// Copy an account's owner bytes now. Wraps pinocchio's unsafe `owner()`:
/// the reference is dereferenced into an array immediately and never retained
/// across CPI/assign/close. All state borrows are dropped before any CPI.
pub fn owner_bytes(view: &pinocchio::AccountView) -> [u8; 32] {
    // SAFETY: immediate copy; no reference escapes.
    unsafe { *view.owner().as_array() }
}
const PROGRAMDATA_VARIANT: u32 = 3;
/// ProgramData metadata length: variant u32 + slot u64 + COption<Pubkey> with a
/// ONE-byte tag (bincode special-cases `Option` to a single byte — verified
/// against chain truth, not assumed: fresh deploys read `01 ‖ authority`).
/// Minimum length; bytecode follows.
const PROGRAMDATA_META_LEN: usize = 45;

/// Parsed ProgramData upgrade record: `(slot, authority, has_authority)`.
pub fn parse_programdata(data: &[u8]) -> Result<(u64, [u8; 32], bool), ProgramError> {
    if data.len() < PROGRAMDATA_META_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let variant = u32::from_le_bytes(data[0..4].try_into().map_err(|_| ProgramError::InvalidAccountData)?);
    if variant != PROGRAMDATA_VARIANT {
        return Err(ProgramError::InvalidAccountData);
    }
    let slot = u64::from_le_bytes(data[4..12].try_into().map_err(|_| ProgramError::InvalidAccountData)?);
    let has_authority = match data[12] {
        0 => false,
        1 => true,
        _ => return Err(ProgramError::InvalidAccountData),
    };
    let mut authority = [0u8; 32];
    if has_authority {
        authority.copy_from_slice(data.get(13..45).ok_or(ProgramError::InvalidAccountData)?);
    }
    Ok((slot, authority, has_authority))
}

/// Derive the ProgramData address for a program id: PDA `[program_id]` under
/// the upgradeable loader. Host-gated like `verify_pda` (unit tests stub 255).
pub fn programdata_address(
    program_id: &pinocchio::Address,
) -> Result<(pinocchio::Address, u8), ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let loader = pinocchio::Address::new_from_array(BPF_LOADER_UPGRADEABLE_ID);
        Ok(pinocchio::Address::find_program_address(&[program_id.as_array()], &loader))
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = program_id;
        Ok((pinocchio::Address::new_from_array([0u8; 32]), 255))
    }
}

/// Returns true for the two token programs (base Account layout shared).
pub fn is_token_program(owner: &[u8; 32]) -> bool {
    owner == &TOKEN_PROGRAM_ID || owner == &TOKEN_2022_PROGRAM_ID
}

/// Base SPL/Token-2022 `Account` authority-field offsets (both layouts share
/// them; 165-byte base state).
const TOKEN_DELEGATE_TAG: usize = 72;
const TOKEN_DELEGATE_KEY: usize = 76;
const TOKEN_CLOSE_TAG: usize = 129;
const TOKEN_CLOSE_KEY: usize = 133;
const TOKEN_BASE_LEN: usize = 165;

/// Snapshot of the authority fields the session invariant watches:
/// `(delegate_tag, delegate, close_tag, close_authority)`. `None` when the
/// account is too short to carry them (caller decides scope).
pub fn snapshot_token_authorities(data: &[u8]) -> Option<([u8; 4], [u8; 32], [u8; 4], [u8; 32])> {
    if data.len() < TOKEN_BASE_LEN {
        return None;
    }
    let dtag: [u8; 4] = data[TOKEN_DELEGATE_TAG..TOKEN_DELEGATE_TAG + 4].try_into().ok()?;
    let dkey: [u8; 32] = data[TOKEN_DELEGATE_KEY..TOKEN_DELEGATE_KEY + 32].try_into().ok()?;
    let ctag: [u8; 4] = data[TOKEN_CLOSE_TAG..TOKEN_CLOSE_TAG + 4].try_into().ok()?;
    let ckey: [u8; 32] = data[TOKEN_CLOSE_KEY..TOKEN_CLOSE_KEY + 32].try_into().ok()?;
    Some((dtag, dkey, ctag, ckey))
}

// ================= Token-2022 extension matrix (ANT-870 P6.1) =================
//
// The session invariant pins `delegate`/`close_authority` plus a full data
// hash — but an extension can move value or authority through fields the
// program never reads (withheld fees, hidden confidential balances, hook CPIs,
// permanent delegates, CPI guards that brick our CPI). Enumerating the safe
// set and failing closed on everything else is the only sound posture:
// balance/authority semantics the program cannot see are never trusted.
//
// Discriminants are spl-token-2022 `ExtensionType` (`repr(u16)`, sequential
// from 0). The walker below is length-agnostic (it skips declared `len`
// bytes), so future extensions fail closed by construction: any type id not
// on the allowlist — including ids that do not exist yet — is rejected.
//
// Layout reminder: an extended account is
// `base[165] ‖ account_type u8 (2 = Account) ‖ TLV…`;
// an extended mint is `base[82] ‖ account_type u8 (1 = Mint) ‖ TLV…`.
// Each TLV entry is `type u16 LE ‖ len u16 LE ‖ value[len]`; a `type == 0`
// (Uninitialized) entry terminates the list and the tail must be zeroed
// realloc space.
//
// -- Token ACCOUNT extensions: supported --
//   ImmutableOwner (7): forbids owner reassignment; no transfer semantics, no
//   new authority. The sole supported account extension.
//
// -- Token ACCOUNT extensions: explicitly UNSUPPORTED (fail closed) --
//   TransferFeeAmount (2): withheld fees make the visible `amount` a lie.
//   ConfidentialTransferAccount (5): real balances are hidden (ElGamal);
//     the base `amount` field does not reflect spendable value.
//   MemoTransfer (8): inbound transfers require a memo instruction our CPI
//     never sends — allowlisting would bless calls that fail emergently.
//   CpiGuard (11): locks privileged operations behind non-CPI; our
//     session CPI path is exactly what it bricks.
//   NonTransferableAccount (13): dead funds; no flow can use them.
//   TransferHookAccount (15): every transfer CPIs an untrusted hook program
//     (Reentrancy lens: foreign code runs inside our value-moving CPI).
//   ConfidentialTransferFeeAmount (17): hidden withheld fees (see 2 + 5).
//   PausableAccount (27): the mint can freeze the account mid-flow (liveness).
//   Any mint-side type on an account (1,3,4,6,9,10,12,14,16,18-26,28):
//     malformed (`ExtensionBaseMismatch` class) — rejected as invalid data.
//
// -- Token MINT extensions: supported --
//   (none beyond the base 82 bytes, plus pure metadata/group pointers)
//   MetadataPointer (18), TokenMetadata (19), GroupPointer (20),
//   TokenGroup (21), GroupMemberPointer (22), TokenGroupMember (23):
//   descriptive only — no transfer math, no privileged holder authority.
//
// -- Token MINT extensions: explicitly UNSUPPORTED --
//   TransferFeeConfig (1): silently withholds a cut of every transfer — the
//     user's signed `amount` would not reach the destination.
//   MintCloseAuthority (3): privileged mint-lifecycle authority (least-
//     privilege lens: unknown third party controls the mint account).
//   ConfidentialTransferMint (4), ConfidentialTransferFeeConfig (16),
//   ConfidentialMintBurn (24): hidden-amount semantics (see account 5).
//   DefaultAccountState (6): auto-freezes new holder accounts (liveness).
//   NonTransferable (9): mint whose tokens can never move.
//   InterestBearingConfig (10), ScaledUiAmount (25): amount is a function of
//     time/scale — the signed integer is not the economic value.
//   PermanentDelegate (12): unilateral confiscation authority over ALL
//     holder accounts (Access-control lens: God-authority class).
//   TransferHook (14): untrusted program runs inside every transfer.
//   Pausable (26): mint can halt all transfers (liveness).
//   PermissionedBurn (28): burn-gated semantics our flows do not model.
//   Any account-side type on a mint: malformed — rejected as invalid data.
//
// Gas lens: the walk is O(extensions), bounded by account size (≤ a few 10s
// of entries); it runs once per token account per instruction, off the CPI
// path — measured in hundreds of compute units, not worth optimizing.

/// Base lengths: SPL Token / Token-2022 `Account` (165) and `Mint` (82).
pub const TOKEN_MINT_BASE_LEN: usize = 82;
/// `AccountType` tag byte values (spl-token-2022): 0 uninitialized, 1 mint, 2 account.
const ACCOUNT_TYPE_UNINITIALIZED: u8 = 0;
const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;

/// ExtensionType ids (spl-token-2022 `extension/mod.rs`, `repr(u16)` order).
/// Only the ids the policy below names are spelled out; anything else —
/// including future ids — is unsupported by construction.
const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
const EXT_TRANSFER_FEE_AMOUNT: u16 = 2;
const EXT_MINT_CLOSE_AUTHORITY: u16 = 3;
const EXT_CONFIDENTIAL_TRANSFER_MINT: u16 = 4;
const EXT_CONFIDENTIAL_TRANSFER_ACCOUNT: u16 = 5;
const EXT_DEFAULT_ACCOUNT_STATE: u16 = 6;
const EXT_IMMUTABLE_OWNER: u16 = 7;
const EXT_MEMO_TRANSFER: u16 = 8;
const EXT_NON_TRANSFERABLE: u16 = 9;
const EXT_INTEREST_BEARING_CONFIG: u16 = 10;
const EXT_CPI_GUARD: u16 = 11;
const EXT_PERMANENT_DELEGATE: u16 = 12;
const EXT_NON_TRANSFERABLE_ACCOUNT: u16 = 13;
const EXT_TRANSFER_HOOK: u16 = 14;
const EXT_TRANSFER_HOOK_ACCOUNT: u16 = 15;
const EXT_CONFIDENTIAL_TRANSFER_FEE_CONFIG: u16 = 16;
const EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT: u16 = 17;
const EXT_METADATA_POINTER: u16 = 18;
const EXT_TOKEN_METADATA: u16 = 19;
const EXT_GROUP_POINTER: u16 = 20;
const EXT_TOKEN_GROUP: u16 = 21;
const EXT_GROUP_MEMBER_POINTER: u16 = 22;
const EXT_TOKEN_GROUP_MEMBER: u16 = 23;
const EXT_CONFIDENTIAL_MINT_BURN: u16 = 24;
const EXT_SCALED_UI_AMOUNT: u16 = 25;
const EXT_PAUSABLE: u16 = 26;
const EXT_PAUSABLE_ACCOUNT: u16 = 27;
const EXT_PERMISSIONED_BURN: u16 = 28;

/// Fail-closed verdict for one TLV entry on the account side.
fn check_account_extension(ext_type: u16) -> Result<(), ProgramError> {
    match ext_type {
        // The sole supported account extension (matrix above).
        EXT_IMMUTABLE_OWNER => Ok(()),
        // Recognized but unsupported: transfer/amount/hidden-balance/hook/
        // freeze semantics the vault and session flows cannot see.
        EXT_TRANSFER_FEE_AMOUNT
        | EXT_CONFIDENTIAL_TRANSFER_ACCOUNT
        | EXT_MEMO_TRANSFER
        | EXT_CPI_GUARD
        | EXT_NON_TRANSFERABLE_ACCOUNT
        | EXT_TRANSFER_HOOK_ACCOUNT
        | EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT
        | EXT_PAUSABLE_ACCOUNT => Err(PeridotError::UnsupportedTokenExtension.into()),
        // Mint-side types on an account (or test padding): malformed.
        _ => Err(if is_mint_side_extension(ext_type) {
            ProgramError::InvalidAccountData
        } else {
            PeridotError::UnsupportedTokenExtension.into()
        }),
    }
}

/// Fail-closed verdict for one TLV entry on the mint side.
fn check_mint_extension(ext_type: u16) -> Result<(), ProgramError> {
    match ext_type {
        // Pure metadata/group pointers: no transfer math, no holder authority.
        EXT_METADATA_POINTER
        | EXT_TOKEN_METADATA
        | EXT_GROUP_POINTER
        | EXT_TOKEN_GROUP
        | EXT_GROUP_MEMBER_POINTER
        | EXT_TOKEN_GROUP_MEMBER => Ok(()),
        // Recognized but unsupported: fee skims, hidden amounts, privileged
        // delegates/hooks, freeze/pausable semantics.
        EXT_TRANSFER_FEE_CONFIG
        | EXT_MINT_CLOSE_AUTHORITY
        | EXT_CONFIDENTIAL_TRANSFER_MINT
        | EXT_DEFAULT_ACCOUNT_STATE
        | EXT_NON_TRANSFERABLE
        | EXT_INTEREST_BEARING_CONFIG
        | EXT_PERMANENT_DELEGATE
        | EXT_TRANSFER_HOOK
        | EXT_CONFIDENTIAL_TRANSFER_FEE_CONFIG
        | EXT_CONFIDENTIAL_MINT_BURN
        | EXT_SCALED_UI_AMOUNT
        | EXT_PAUSABLE
        | EXT_PERMISSIONED_BURN => Err(PeridotError::UnsupportedTokenExtension.into()),
        // Account-side types on a mint (or test padding): malformed.
        _ => Err(if is_account_side_extension(ext_type) {
            ProgramError::InvalidAccountData
        } else {
            PeridotError::UnsupportedTokenExtension.into()
        }),
    }
}

fn is_mint_side_extension(ext_type: u16) -> bool {
    matches!(
        ext_type,
        EXT_TRANSFER_FEE_CONFIG
            | EXT_MINT_CLOSE_AUTHORITY
            | EXT_CONFIDENTIAL_TRANSFER_MINT
            | EXT_DEFAULT_ACCOUNT_STATE
            | EXT_NON_TRANSFERABLE
            | EXT_INTEREST_BEARING_CONFIG
            | EXT_PERMANENT_DELEGATE
            | EXT_TRANSFER_HOOK
            | EXT_CONFIDENTIAL_TRANSFER_FEE_CONFIG
            | EXT_METADATA_POINTER
            | EXT_TOKEN_METADATA
            | EXT_GROUP_POINTER
            | EXT_TOKEN_GROUP
            | EXT_GROUP_MEMBER_POINTER
            | EXT_TOKEN_GROUP_MEMBER
            | EXT_CONFIDENTIAL_MINT_BURN
            | EXT_SCALED_UI_AMOUNT
            | EXT_PAUSABLE
            | EXT_PERMISSIONED_BURN
    )
}

fn is_account_side_extension(ext_type: u16) -> bool {
    matches!(
        ext_type,
        EXT_TRANSFER_FEE_AMOUNT
            | EXT_CONFIDENTIAL_TRANSFER_ACCOUNT
            | EXT_IMMUTABLE_OWNER
            | EXT_MEMO_TRANSFER
            | EXT_NON_TRANSFERABLE_ACCOUNT
            | EXT_TRANSFER_HOOK_ACCOUNT
            | EXT_CPI_GUARD
            | EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT
            | EXT_PAUSABLE_ACCOUNT
    )
}

/// Walk the TLV extension area (`tlv` starts right after the account-type
/// byte). `check` classifies each entry; `Uninitialized` (0) terminates the
/// list and the tail must be zeroed realloc space.
fn walk_tlv(
    tlv: &[u8],
    check: fn(u16) -> Result<(), ProgramError>,
) -> Result<(), ProgramError> {
    let mut cursor = 0usize;
    loop {
        let rest = tlv.len().saturating_sub(cursor);
        if rest == 0 {
            return Ok(());
        }
        if rest < 4 {
            // A partial header is only valid as zeroed realloc padding.
            return if tlv[cursor..].iter().all(|&b| b == 0) {
                Ok(())
            } else {
                Err(ProgramError::InvalidAccountData)
            };
        }
        let ext_type = u16::from_le_bytes([tlv[cursor], tlv[cursor + 1]]);
        if ext_type == 0 {
            // Uninitialized: end of list; the tail must be zeroed space.
            return if tlv[cursor..].iter().all(|&b| b == 0) {
                Ok(())
            } else {
                Err(ProgramError::InvalidAccountData)
            };
        }
        let len = u16::from_le_bytes([tlv[cursor + 2], tlv[cursor + 3]]) as usize;
        let value_end = cursor.saturating_add(4).saturating_add(len);
        if value_end > tlv.len() {
            return Err(ProgramError::InvalidAccountData);
        }
        check(ext_type)?;
        cursor = value_end;
    }
}

/// Gate a token ACCOUNT's data against the extension matrix: base 165-byte
/// accounts pass trivially; longer accounts must carry a valid TLV area whose
/// every entry is supported. Data shorter than the base is left to the
/// caller/CPI (fail-closed there) — this gate only rules on extensions.
pub fn check_token_account_supported(data: &[u8]) -> Result<(), ProgramError> {
    if data.len() <= TOKEN_BASE_LEN {
        return Ok(());
    }
    if data[TOKEN_BASE_LEN] == ACCOUNT_TYPE_UNINITIALIZED {
        // Zeroed realloc space with no initialized extensions.
        return if data[TOKEN_BASE_LEN..].iter().all(|&b| b == 0) {
            Ok(())
        } else {
            Err(ProgramError::InvalidAccountData)
        };
    }
    if data[TOKEN_BASE_LEN] != ACCOUNT_TYPE_ACCOUNT {
        return Err(ProgramError::InvalidAccountData);
    }
    walk_tlv(&data[TOKEN_BASE_LEN + 1..], check_account_extension)
}

/// Gate a token MINT's data against the extension matrix: base 82-byte mints
/// pass trivially; longer mints must carry a valid TLV area of supported
/// (metadata/group-pointer) entries only.
pub fn check_token_mint_supported(data: &[u8]) -> Result<(), ProgramError> {
    if data.len() <= TOKEN_MINT_BASE_LEN {
        return Ok(());
    }
    if data[TOKEN_MINT_BASE_LEN] == ACCOUNT_TYPE_UNINITIALIZED {
        return if data[TOKEN_MINT_BASE_LEN..].iter().all(|&b| b == 0) {
            Ok(())
        } else {
            Err(ProgramError::InvalidAccountData)
        };
    }
    if data[TOKEN_MINT_BASE_LEN] != ACCOUNT_TYPE_MINT {
        return Err(ProgramError::InvalidAccountData);
    }
    walk_tlv(&data[TOKEN_MINT_BASE_LEN + 1..], check_mint_extension)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn programdata_parses_upgrade_record() {
        let mut data = [0u8; 45];
        data[0..4].copy_from_slice(&3u32.to_le_bytes());
        data[4..12].copy_from_slice(&12345u64.to_le_bytes());
        data[12] = 1;
        data[13..45].copy_from_slice(&[0xabu8; 32]);
        let (slot, auth, has) = parse_programdata(&data).unwrap();
        assert_eq!(slot, 12345);
        assert!(has);
        assert_eq!(auth, [0xabu8; 32]);
    }

    #[test]
    fn programdata_parses_immutable_record() {
        let mut data = [0u8; 45];
        data[0..4].copy_from_slice(&3u32.to_le_bytes());
        data[4..12].copy_from_slice(&99u64.to_le_bytes());
        data[12] = 0;
        let (slot, auth, has) = parse_programdata(&data).unwrap();
        assert_eq!(slot, 99);
        assert!(!has);
        assert_eq!(auth, [0u8; 32]);
    }

    #[test]
    fn programdata_rejects_non_programdata_variant() {
        let mut data = [0u8; 48];
        data[0..4].copy_from_slice(&1u32.to_le_bytes());
        assert!(parse_programdata(&data).is_err());
    }

    // ---- ANT-870 P6.1: extension-matrix probe tests ----

    /// Build an extended token account: base[165] ‖ 0x02 ‖ entries.
    fn extended_account(entries: &[(u16, &[u8])], tail_zeros: usize) -> alloc::vec::Vec<u8> {
        let mut v = alloc::vec![0u8; TOKEN_BASE_LEN];
        v.push(ACCOUNT_TYPE_ACCOUNT);
        for (ty, val) in entries {
            v.extend_from_slice(&ty.to_le_bytes());
            v.extend_from_slice(&(val.len() as u16).to_le_bytes());
            v.extend_from_slice(val);
        }
        v.extend(alloc::vec![0u8; tail_zeros]);
        v
    }

    /// Build an extended token mint: base[82] ‖ 0x01 ‖ entries.
    fn extended_mint(entries: &[(u16, &[u8])]) -> alloc::vec::Vec<u8> {
        let mut v = alloc::vec![0u8; TOKEN_MINT_BASE_LEN];
        v.push(ACCOUNT_TYPE_MINT);
        for (ty, val) in entries {
            v.extend_from_slice(&ty.to_le_bytes());
            v.extend_from_slice(&(val.len() as u16).to_le_bytes());
            v.extend_from_slice(val);
        }
        v
    }

    #[test]
    fn base_accounts_and_mints_pass_trivially() {
        assert!(check_token_account_supported(&[0u8; TOKEN_BASE_LEN]).is_ok());
        assert!(check_token_account_supported(&[0u8; 72]).is_ok()); // short: caller/CPI scope
        assert!(check_token_mint_supported(&[0u8; TOKEN_MINT_BASE_LEN]).is_ok());
        assert!(check_token_mint_supported(&[0u8; 32]).is_ok());
    }

    #[test]
    fn immutable_owner_is_the_supported_account_extension() {
        let v = extended_account(&[(EXT_IMMUTABLE_OWNER, &[])], 0);
        assert!(check_token_account_supported(&v).is_ok());
        // Zeroed realloc tail after the list is still supported.
        let v = extended_account(&[(EXT_IMMUTABLE_OWNER, &[])], 16);
        assert!(check_token_account_supported(&v).is_ok());
        // Zeroed space with no entries at all is supported.
        let mut v = alloc::vec![0u8; TOKEN_BASE_LEN];
        v.extend_from_slice(&[0u8; 8]);
        assert!(check_token_account_supported(&v).is_ok());
    }

    #[test]
    fn dangerous_account_extensions_fail_closed() {
        for ty in [
            EXT_TRANSFER_FEE_AMOUNT,
            EXT_CONFIDENTIAL_TRANSFER_ACCOUNT,
            EXT_MEMO_TRANSFER,
            EXT_CPI_GUARD,
            EXT_NON_TRANSFERABLE_ACCOUNT,
            EXT_TRANSFER_HOOK_ACCOUNT,
            EXT_CONFIDENTIAL_TRANSFER_FEE_AMOUNT,
            EXT_PAUSABLE_ACCOUNT,
        ] {
            let v = extended_account(&[(ty, &[1u8; 8])], 0);
            assert_eq!(
                check_token_account_supported(&v),
                Err(PeridotError::UnsupportedTokenExtension.into()),
                "extension {ty} must fail closed"
            );
        }
        // Unknown future ids fail closed too (never allowlist-by-default).
        for ty in [29u16, 99, 1000, u16::MAX] {
            let v = extended_account(&[(ty, &[0u8; 4])], 0);
            assert_eq!(
                check_token_account_supported(&v),
                Err(PeridotError::UnsupportedTokenExtension.into()),
                "unknown extension {ty} must fail closed"
            );
        }
    }

    #[test]
    fn mint_side_type_on_account_is_malformed() {
        let v = extended_account(&[(EXT_TRANSFER_FEE_CONFIG, &[0u8; 8])], 0);
        assert_eq!(
            check_token_account_supported(&v),
            Err(ProgramError::InvalidAccountData)
        );
    }

    #[test]
    fn metadata_group_mints_pass_fee_mints_fail() {
        for ty in [
            EXT_METADATA_POINTER,
            EXT_TOKEN_METADATA,
            EXT_GROUP_POINTER,
            EXT_TOKEN_GROUP,
            EXT_GROUP_MEMBER_POINTER,
            EXT_TOKEN_GROUP_MEMBER,
        ] {
            let v = extended_mint(&[(ty, &[0u8; 8])]);
            assert!(check_token_mint_supported(&v).is_ok(), "mint ext {ty} must pass");
        }
        for ty in [
            EXT_TRANSFER_FEE_CONFIG,
            EXT_MINT_CLOSE_AUTHORITY,
            EXT_CONFIDENTIAL_TRANSFER_MINT,
            EXT_DEFAULT_ACCOUNT_STATE,
            EXT_NON_TRANSFERABLE,
            EXT_INTEREST_BEARING_CONFIG,
            EXT_PERMANENT_DELEGATE,
            EXT_TRANSFER_HOOK,
            EXT_CONFIDENTIAL_TRANSFER_FEE_CONFIG,
            EXT_CONFIDENTIAL_MINT_BURN,
            EXT_SCALED_UI_AMOUNT,
            EXT_PAUSABLE,
            EXT_PERMISSIONED_BURN,
        ] {
            let v = extended_mint(&[(ty, &[0u8; 8])]);
            assert_eq!(
                check_token_mint_supported(&v),
                Err(PeridotError::UnsupportedTokenExtension.into()),
                "mint ext {ty} must fail closed"
            );
        }
        // Unknown future mint ids fail closed as well.
        let v = extended_mint(&[(77u16, &[0u8; 4])]);
        assert_eq!(
            check_token_mint_supported(&v),
            Err(PeridotError::UnsupportedTokenExtension.into())
        );
    }

    #[test]
    fn account_side_type_on_mint_is_malformed() {
        let v = extended_mint(&[(EXT_MEMO_TRANSFER, &[0u8; 2])]);
        assert_eq!(
            check_token_mint_supported(&v),
            Err(ProgramError::InvalidAccountData)
        );
    }

    #[test]
    fn malformed_tlv_fails_closed() {
        // Truncated header (nonzero partial bytes).
        let mut v = alloc::vec![0u8; TOKEN_BASE_LEN];
        v.push(ACCOUNT_TYPE_ACCOUNT);
        v.extend_from_slice(&[9u8, 0, 1]);
        assert_eq!(
            check_token_account_supported(&v),
            Err(ProgramError::InvalidAccountData)
        );
        // Declared length overruns the buffer.
        let mut v = alloc::vec![0u8; TOKEN_BASE_LEN];
        v.push(ACCOUNT_TYPE_ACCOUNT);
        v.extend_from_slice(&EXT_IMMUTABLE_OWNER.to_le_bytes());
        v.extend_from_slice(&9999u16.to_le_bytes());
        assert_eq!(
            check_token_account_supported(&v),
            Err(ProgramError::InvalidAccountData)
        );
        // Wrong account-type tag.
        let mut v = alloc::vec![0u8; TOKEN_BASE_LEN];
        v.push(ACCOUNT_TYPE_MINT);
        assert_eq!(
            check_token_account_supported(&v),
            Err(ProgramError::InvalidAccountData)
        );
        // Nonzero garbage after Uninitialized terminator.
        let mut v = alloc::vec![0u8; TOKEN_BASE_LEN];
        v.push(ACCOUNT_TYPE_ACCOUNT);
        v.extend_from_slice(&[0u8, 0, 0, 0, 7u8]);
        assert_eq!(
            check_token_account_supported(&v),
            Err(ProgramError::InvalidAccountData)
        );
    }

    #[test]
    fn unsupported_extension_uses_fresh_discriminant() {
        // Additive-only error table: the new variant is 29, 0-28 untouched.
        assert_eq!(PeridotError::UnsupportedTokenExtension as u32, 29);
        assert_eq!(PeridotError::CannotRemoveLastAdmin as u32, 28);
    }
}
