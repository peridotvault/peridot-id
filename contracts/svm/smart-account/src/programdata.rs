//! Upgradeable-loader and token-account parsing for the session layer (ADR-010).
//!
//! All addresses below are system constants — verified end-to-end by the
//! integration suite (registration passes a chain-read ProgramData account and
//! real token accounts; wrong bytes fail closed, never open).

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
}
