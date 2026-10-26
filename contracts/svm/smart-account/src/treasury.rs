//! Program-bound revenue vault (ANT-635 option a, ANT-638).
//!
//! The protocol fee (`floor(network_fee x bps/10000)`, `fee.rs`) flows into a
//! PDA vault bound to the program id instead of a build-baked EOA const:
//!
//! - Treasury vault PDA: seeds `[b"treasury"]`, owner = `program_id`.
//! - Revenue config PDA: seeds `[b"config"]`, owner = `program_id`.
//!
//! Derivation MUST use the runtime `program_id` (as `state::verify_pda` does),
//! never the baked `ID`, so gate and derivation cannot split-brain.
//!
//! Config PDA layout v1 (264 bytes total):
//! ```text
//! offset  field            type              notes
//! 0       version          u8                = 1 (CONFIG_VERSION_V1)
//! 1       admin_count      u8                live admin count, floor 1 enforced
//! 2       treasury_bump    u8                canonical bump of ["treasury"]
//! 3       config_bump      u8                canonical bump of ["config"]
//! 4       _reserved       [u8; 4]           zeroed, future flags
//! 8       admins          [[u8;32]; 8]      fixed 8 slots, [0..admin_count) live
//! ```
//!
//! Deny rules (revenue-only isolation — audit MUST verify each):
//! - D1: new instructions touch ONLY treasury PDA + config PDA (+ destination
//!   for withdrawals). NEVER user PDA state, session PDAs, or BACKEND.
//! - D2: `WithdrawRevenue` destination MUST NOT equal treasury/config PDA and
//!   MUST NOT be owned by this program.
//! - D3: no new instruction reads or writes `config::BACKEND`; creation gates
//!   untouched (there is no BACKEND const anymore — ANT-612).
//! - D4: `WithdrawRevenue` performs NO CPI and NO `invoke_signed`; lamport
//!   moves are direct `set_lamports` only.
//! - D5: fee call-sites keep exact `split_attested_fee` math; only the treasury
//!   identity check changes (const equality -> PDA derivation equality).
//!
//! Discriminant note: the ANT-637 spec reserved 11-14, but those slots are
//! already taken by the V4 fee-capped siblings (`WithdrawSolV4 = 11`,
//! `WithdrawTokenV4 = 12`, `ExecuteV4 = 13`, `ActivateV4 = 14`). The new
//! instructions take the next free slots 15-18 (additive-only preserved).
//! Error note: spec error 24 (`NotAdmin`) collided with the shipped
//! `SessionSpendExceeded = 24`, so the vault errors take 25-28.

use crate::errors::PeridotError;
use pinocchio::error::ProgramError;

/// PDA seed for the revenue vault.
pub const TREASURY_SEED: &[u8] = b"treasury";
/// PDA seed for the revenue config.
pub const CONFIG_SEED: &[u8] = b"config";

/// Config version written by v1 writers.
pub const CONFIG_VERSION_V1: u8 = 1;
/// Maximum live admins (fixed slots, in-place mutation, no realloc).
pub const MAX_ADMINS: usize = 8;
/// Config account space: 8-byte header + 8 x 32-byte admin slots.
pub const CONFIG_LEN: usize = 264;

const OFF_VERSION: usize = 0;
const OFF_ADMIN_COUNT: usize = 1;
const OFF_TREASURY_BUMP: usize = 2;
const OFF_CONFIG_BUMP: usize = 3;
const OFF_ADMINS: usize = 8;
const ADMIN_LEN: usize = 32;

/// Verify the treasury vault PDA against seeds `[b"treasury"]` + runtime
/// `program_id`. Returns the canonical bump.
///
/// On host (unit tests) the bpf-gated syscall derivation is unavailable; the
/// real PDA derivation is exercised by the on-chain integration suite. Mirrors
/// the `state::verify_pda` stub pattern.
pub fn verify_treasury_pda(
    treasury: &pinocchio::AccountView,
    program_id: &pinocchio::Address,
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected, bump) =
            pinocchio::Address::find_program_address(&[TREASURY_SEED], program_id);
        if treasury.address() != &expected {
            return Err(PeridotError::InvalidPda.into());
        }
        if !treasury.owned_by(program_id) {
            return Err(PeridotError::WrongOwner.into());
        }
        Ok(bump)
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (treasury, program_id);
        Ok(255)
    }
}

/// Verify the revenue config PDA against seeds `[b"config"]` + runtime
/// `program_id`. Returns the canonical bump.
pub fn verify_config_pda(
    config: &pinocchio::AccountView,
    program_id: &pinocchio::Address,
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected, bump) =
            pinocchio::Address::find_program_address(&[CONFIG_SEED], program_id);
        if config.address() != &expected {
            return Err(PeridotError::InvalidPda.into());
        }
        if !config.owned_by(program_id) {
            return Err(PeridotError::WrongOwner.into());
        }
        Ok(bump)
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        let _ = (config, program_id);
        Ok(255)
    }
}

/// Read-only view over the 264-byte config PDA (v1).
#[derive(Clone, Copy)]
pub struct RevenueConfig<'data> {
    data: &'data [u8],
}

impl<'data> RevenueConfig<'data> {
    pub fn try_from_bytes(data: &'data [u8]) -> Result<Self, ProgramError> {
        if data.len() != CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        // Fail-closed forward-compat: only version 1 reads.
        if data[OFF_VERSION] != CONFIG_VERSION_V1 {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[OFF_ADMIN_COUNT] == 0 || data[OFF_ADMIN_COUNT] as usize > MAX_ADMINS {
            return Err(ProgramError::InvalidAccountData);
        }
        // Reserved bytes must be zero (future flags land here).
        if data[OFF_CONFIG_BUMP + 1..OFF_ADMINS].iter().any(|&b| b != 0) {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    pub fn admin_count(&self) -> usize {
        self.data[OFF_ADMIN_COUNT] as usize
    }

    pub fn treasury_bump(&self) -> u8 {
        self.data[OFF_TREASURY_BUMP]
    }

    pub fn config_bump(&self) -> u8 {
        self.data[OFF_CONFIG_BUMP]
    }

    pub fn admin_at(&self, index: usize) -> [u8; 32] {
        let off = OFF_ADMINS + index * ADMIN_LEN;
        self.data[off..off + ADMIN_LEN]
            .try_into()
            .expect("slice is 32 bytes")
    }

    /// True when `signer` is in the live `admins[..count)` window.
    pub fn is_admin(&self, signer: &[u8; 32]) -> bool {
        (0..self.admin_count()).any(|i| &self.admin_at(i) == signer)
    }
}

/// Mutable view over the 264-byte config PDA (v1 writes only).
pub struct RevenueConfigMut<'data> {
    data: &'data mut [u8],
}

impl<'data> RevenueConfigMut<'data> {
    pub fn try_from_bytes(data: &'data mut [u8]) -> Result<Self, ProgramError> {
        if data.len() != CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Ok(Self { data })
    }

    /// Initialize v1 state: `admins[0] = initial_admin`, count 1, bumps stored.
    pub fn initialize(
        &mut self,
        initial_admin: [u8; 32],
        treasury_bump: u8,
        config_bump: u8,
    ) {
        self.data[OFF_VERSION] = CONFIG_VERSION_V1;
        self.data[OFF_ADMIN_COUNT] = 1;
        self.data[OFF_TREASURY_BUMP] = treasury_bump;
        self.data[OFF_CONFIG_BUMP] = config_bump;
        self.data[OFF_CONFIG_BUMP + 1..OFF_ADMINS].fill(0);
        self.data[OFF_ADMINS..OFF_ADMINS + CONFIG_LEN - OFF_ADMINS].fill(0);
        self.data[OFF_ADMINS..OFF_ADMINS + ADMIN_LEN].copy_from_slice(&initial_admin);
    }

    pub fn admin_count(&self) -> usize {
        self.data[OFF_ADMIN_COUNT] as usize
    }

    pub fn is_admin(&self, signer: &[u8; 32]) -> bool {
        (0..self.admin_count()).any(|i| {
            let off = OFF_ADMINS + i * ADMIN_LEN;
            self.data[off..off + ADMIN_LEN] == signer[..]
        })
    }

    /// Add a live admin. Fails `TooManyAdmins` at cap, `InvalidAccountData`
    /// on duplicates (fail-closed: no double slots).
    pub fn add_admin(&mut self, new_admin: [u8; 32]) -> Result<(), ProgramError> {
        let count = self.admin_count();
        if count >= MAX_ADMINS {
            return Err(PeridotError::TooManyAdmins.into());
        }
        if self.is_admin(&new_admin) {
            return Err(ProgramError::InvalidAccountData);
        }
        let off = OFF_ADMINS + count * ADMIN_LEN;
        self.data[off..off + ADMIN_LEN].copy_from_slice(&new_admin);
        self.data[OFF_ADMIN_COUNT] = (count + 1) as u8;
        Ok(())
    }

    /// Remove a live admin by swap-remove. Floor-1 enforced: removing the last
    /// admin fails `CannotRemoveLastAdmin` (EVM `PeridotFactory` floor parity).
    pub fn remove_admin(&mut self, target: [u8; 32]) -> Result<(), ProgramError> {
        let count = self.admin_count();
        if count <= 1 {
            return Err(PeridotError::CannotRemoveLastAdmin.into());
        }
        let mut found: Option<usize> = None;
        for i in 0..count {
            let off = OFF_ADMINS + i * ADMIN_LEN;
            if self.data[off..off + ADMIN_LEN] == target[..] {
                found = Some(i);
                break;
            }
        }
        let index = found.ok_or(ProgramError::InvalidAccountData)?;
        // Swap-remove: move the last live slot into the hole, zero the tail.
        if index + 1 != count {
            let mut last = [0u8; ADMIN_LEN];
            let last_off = OFF_ADMINS + (count - 1) * ADMIN_LEN;
            last.copy_from_slice(&self.data[last_off..last_off + ADMIN_LEN]);
            let off = OFF_ADMINS + index * ADMIN_LEN;
            self.data[off..off + ADMIN_LEN].copy_from_slice(&last);
        }
        let tail_off = OFF_ADMINS + (count - 1) * ADMIN_LEN;
        self.data[tail_off..tail_off + ADMIN_LEN].fill(0);
        self.data[OFF_ADMIN_COUNT] = (count - 1) as u8;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_config() -> ([u8; CONFIG_LEN], [u8; 32]) {
        let admin = [7u8; 32];
        let mut bytes = [0u8; CONFIG_LEN];
        {
            let mut cfg = RevenueConfigMut::try_from_bytes(&mut bytes).unwrap();
            cfg.initialize(admin, 200, 201);
        }
        (bytes, admin)
    }

    #[test]
    fn init_round_trip_v1() {
        let (bytes, admin) = fresh_config();
        let cfg = RevenueConfig::try_from_bytes(&bytes).unwrap();
        assert_eq!(cfg.admin_count(), 1);
        assert_eq!(cfg.admin_at(0), admin);
        assert_eq!(cfg.treasury_bump(), 200);
        assert_eq!(cfg.config_bump(), 201);
        assert!(cfg.is_admin(&admin));
        assert!(!cfg.is_admin(&[9u8; 32]));
    }

    #[test]
    fn unknown_version_rejected() {
        let (mut bytes, _) = fresh_config();
        bytes[OFF_VERSION] = 2;
        assert!(RevenueConfig::try_from_bytes(&bytes).is_err());
        bytes[OFF_VERSION] = 0;
        assert!(RevenueConfig::try_from_bytes(&bytes).is_err());
    }

    #[test]
    fn wrong_len_rejected() {
        assert!(RevenueConfig::try_from_bytes(&[0u8; 80]).is_err());
        assert!(RevenueConfig::try_from_bytes(&[0u8; 265]).is_err());
    }

    #[test]
    fn add_up_to_cap_then_too_many() {
        let (mut bytes, admin) = fresh_config();
        let mut cfg = RevenueConfigMut::try_from_bytes(&mut bytes).unwrap();
        // Initial admin is [7; 32]; add 7 distinct admins to reach the cap.
        for i in 0..(MAX_ADMINS as u8 - 1) {
            cfg.add_admin([i * 16 + 1; 32]).unwrap();
        }
        assert_eq!(cfg.admin_count(), MAX_ADMINS);
        let err = cfg.add_admin([99u8; 32]).unwrap_err();
        assert_eq!(err, ProgramError::from(PeridotError::TooManyAdmins));
        // Duplicate add fails closed (no double slot).
        let dup = cfg.add_admin(admin).unwrap_err();
        // At cap the cap error wins; below cap duplicates are InvalidAccountData.
        assert!(
            dup == ProgramError::from(PeridotError::TooManyAdmins)
                || dup == ProgramError::InvalidAccountData
        );
    }

    #[test]
    fn duplicate_add_rejected_below_cap() {
        let (mut bytes, admin) = fresh_config();
        let mut cfg = RevenueConfigMut::try_from_bytes(&mut bytes).unwrap();
        let err = cfg.add_admin(admin).unwrap_err();
        assert_eq!(err, ProgramError::InvalidAccountData);
    }

    #[test]
    fn remove_at_one_fails_floor() {
        let (mut bytes, admin) = fresh_config();
        let mut cfg = RevenueConfigMut::try_from_bytes(&mut bytes).unwrap();
        let err = cfg.remove_admin(admin).unwrap_err();
        assert_eq!(err, ProgramError::from(PeridotError::CannotRemoveLastAdmin));
    }

    #[test]
    fn remove_unknown_admin_rejected() {
        let (mut bytes, _) = fresh_config();
        let mut cfg = RevenueConfigMut::try_from_bytes(&mut bytes).unwrap();
        cfg.add_admin([2u8; 32]).unwrap();
        let err = cfg.remove_admin([3u8; 32]).unwrap_err();
        assert_eq!(err, ProgramError::InvalidAccountData);
    }

    #[test]
    fn remove_swap_compacts_live_window() {
        let (mut bytes, _) = fresh_config();
        let (a, b, c) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        let mut cfg = RevenueConfigMut::try_from_bytes(&mut bytes).unwrap();
        cfg.add_admin(a).unwrap();
        cfg.add_admin(b).unwrap();
        cfg.add_admin(c).unwrap();
        assert_eq!(cfg.admin_count(), 4);
        cfg.remove_admin(a).unwrap();
        assert_eq!(cfg.admin_count(), 3);
        assert!(!cfg.is_admin(&a));
        assert!(cfg.is_admin(&b));
        assert!(cfg.is_admin(&c));
        let view = RevenueConfig::try_from_bytes(&bytes).unwrap();
        assert_eq!(view.admin_count(), 3);
    }

    #[test]
    fn config_len_is_264() {
        assert_eq!(CONFIG_LEN, 264);
        assert_eq!(OFF_ADMINS + MAX_ADMINS * ADMIN_LEN, CONFIG_LEN);
    }
}
