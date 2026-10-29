//! Instruction definitions and dispatch.

use pinocchio::error::ProgramError;

pub mod activate;
pub mod activate_v4;
pub mod add_admin;
pub mod close;
pub mod close_cancel;
pub mod close_finalize;
pub mod close_request;
pub mod close_session;
pub mod execute;
/// V5 cluster-bound sibling of `execute` (ANT-868 B4 proving slice):
/// identical layout, V5 domain + program/cluster binding. Additive-only.
pub mod execute_v5;
pub mod execute_v4;
pub mod initialize;
pub mod init_treasury;
pub mod register_session;
pub mod remove_admin;
pub mod revoke_session;
pub mod session_execute;
pub mod update_authority;
/// V5 cluster-bound sibling of `update_authority` (ANT-868 B4 proving slice):
/// identical layout, V5 domain + program/cluster binding. Additive-only.
pub mod update_authority_v5;
pub mod withdraw_revenue;
pub mod withdraw_sol;
pub mod withdraw_sol_v4;
pub mod withdraw_token;
pub mod withdraw_token_v4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Instruction {
    Initialize = 0,
    WithdrawSol = 1,
    WithdrawToken = 2,
    UpdateAuthority = 3,
    Close = 4,
    Activate = 5,
    Execute = 6,
    RegisterSession = 7,
    SessionExecute = 8,
    RevokeSession = 9,
    CloseSession = 10,
    /// V4 fee-capped siblings (ANT-544 B5, ANT-556): each mirrors its V3
    /// counterpart's layout plus a trailing `max_total_fee u64`, verified under
    /// `DOMAIN_V4` with `total ≤ max_total_fee` enforced. Additive-only: V3
    /// discriminants 0-10 are untouched so old SDK decoders keep working.
    WithdrawSolV4 = 11,
    WithdrawTokenV4 = 12,
    ExecuteV4 = 13,
    ActivateV4 = 14,
    /// ANT-635 program-bound revenue vault (ANT-638): creates the config PDA
    /// (`["config"]`, 264-byte v1) + treasury PDA (`["treasury"]`, 0 bytes).
    /// Additive-only: V3 discriminants 0-10 and V4 11-14 are untouched
    /// (spec ANT-637 reserved 11-14, but those were already taken by V4).
    InitTreasury = 15,
    /// ANT-635: admin-gated revenue withdrawal from the treasury PDA.
    WithdrawRevenue = 16,
    /// ANT-635: add a live admin to the config PDA (cap 8).
    AddAdmin = 17,
    /// ANT-635: remove a live admin (floor-1 enforced).
    RemoveAdmin = 18,
    /// ANT-868 B4 V5 cluster-bound proving slice (additive-only): each mirrors
    /// its V3 counterpart's layout byte-for-byte and verifies under
    /// `DOMAIN_V5` with the runtime program id + baked `CLUSTER_ID` bound
    /// after the op-tag. Discriminants 22-29 (owner) and 30-32 (session) are
    /// RESERVED for the remaining-path migration — do not assign ad hoc.
    UpdateAuthorityV5 = 20,
    ExecuteV5 = 21,
    /// ANT-866 B1 close-grace flow (additive-only): teardown is a two-phase
    /// owner-authorized flow with an unclaim grace window plus a permanent
    /// tombstone. Discriminants 33-35 sit beyond the V5 reservations (19 free,
    /// 22-32 reserved) so no pin moves: 19 stays unassigned.
    CloseRequest = 33,
    CloseCancel = 34,
    CloseFinalize = 35,
}

impl TryFrom<u8> for Instruction {
    type Error = ProgramError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            0 => Ok(Self::Initialize),
            1 => Ok(Self::WithdrawSol),
            2 => Ok(Self::WithdrawToken),
            3 => Ok(Self::UpdateAuthority),
            4 => Ok(Self::Close),
            5 => Ok(Self::Activate),
            6 => Ok(Self::Execute),
            7 => Ok(Self::RegisterSession),
            8 => Ok(Self::SessionExecute),
            9 => Ok(Self::RevokeSession),
            10 => Ok(Self::CloseSession),
            11 => Ok(Self::WithdrawSolV4),
            12 => Ok(Self::WithdrawTokenV4),
            13 => Ok(Self::ExecuteV4),
            14 => Ok(Self::ActivateV4),
            15 => Ok(Self::InitTreasury),
            16 => Ok(Self::WithdrawRevenue),
            17 => Ok(Self::AddAdmin),
            18 => Ok(Self::RemoveAdmin),
            20 => Ok(Self::UpdateAuthorityV5),
            21 => Ok(Self::ExecuteV5),
            33 => Ok(Self::CloseRequest),
            34 => Ok(Self::CloseCancel),
            35 => Ok(Self::CloseFinalize),
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// Fixed-layout V3 instruction payload after the discriminator byte.
///
/// Layouts (all multi-byte integers little-endian; `network_fee` is the submitter-
/// attested realtime network cost — the program recomputes the protocol fee from
/// the signed policy version, never trusting a caller-supplied total):
/// - Initialize:      account_id [u8; 32] | authority [u8; 33] | len u16 | clientDataJSON
/// - WithdrawSol:     nonce u64 | amount u64 | destination [u8; 32] | expiry i64 | policy u16 | network_fee u64 | len u16 | clientDataJSON
/// - WithdrawToken:   nonce u64 | amount u64 | destination_ata [u8; 32] | expiry i64 | policy u16 | network_fee u64 | len u16 | clientDataJSON
/// - UpdateAuthority: nonce u64 | new_authority [u8; 33] | expiry i64 | len u16 | clientDataJSON
/// - Close:           nonce u64 | expiry i64 | len u16 | clientDataJSON
/// - Activate:        account_id [u8; 32] | authority [u8; 33] | policy u16 | expiry i64 | network_fee u64 | len u16 | clientDataJSON
/// - Execute:         nonce u64 | target [u8; 32] | meta_count u8 | metas meta_count×(addr[32] ‖ flags u8) | data_len u16 | data | expiry i64 | policy u16 | network_fee u64 | len u16 | clientDataJSON
/// V4 fee-capped layouts (ANT-544 B5, ANT-556 — discriminators 11-14, verified
/// under `DOMAIN_V4` with `total ≤ max_total_fee` else `FeeExceedsMax`; the fee
/// formula follows the signed policy version via `fee::policy_protocol_bps_v4`)
/// - WithdrawSolV4:   V3 WithdrawSol | max_total_fee u64 (after network_fee)
/// - WithdrawTokenV4: V3 WithdrawToken | max_total_fee u64 (after network_fee)
/// - ExecuteV4:       V3 Execute | max_total_fee u64 (after network_fee)
/// - ActivateV4:      V3 Activate | max_total_fee u64 (after network_fee)
/// Every V3 authorization payload starts with the one-byte op-tag (`auth::OP_*`,
/// equal to the discriminator) followed by `account_id`, so a signature for one
/// operation or one account can never authorize another. Fee recipients are
/// canonical (the `[b"treasury"]` PDA revenue vault for the protocol fee — see
/// `crate::treasury` — the relayer signer for the exact network-cost
/// reimbursement) — no per-call treasury.
/// The `len u16` prefixes the raw WebAuthn clientDataJSON passed for on-chain
/// verification.
/// New vault instructions (ANT-635, additive discriminants 15-18):
/// - InitTreasury (15): `initial_admin [u8; 32]`
/// - WithdrawRevenue (16): `amount u64`
/// - AddAdmin (17): `new_admin [u8; 32]`
/// - RemoveAdmin (18): `admin [u8; 32]`
/// Withdraws/activations are relayer-sponsored: `protocol_fee` is recomputed as
/// `floor(network_fee × bps / 10_000)` per the signed fee-policy version.
/// V5 cluster-bound layouts (ANT-868 B4 — discriminators 20-21, verified
/// under `DOMAIN_V5` with `program_id ‖ CLUSTER_ID` bound after the op-tag):
/// - UpdateAuthorityV5 (20): same bytes as V3 UpdateAuthority
/// - ExecuteV5 (21):          same bytes as V3 Execute
/// ANT-866 B1 close-grace layouts (discriminators 33-35, V3 domain):
/// - CloseRequest (33):  `nonce u64 | destination [u8; 32] | expiry i64 | len u16 | clientDataJSON`
/// - CloseCancel (34):   `nonce u64 | expiry i64 | len u16 | clientDataJSON`
/// - CloseFinalize (35): no data (permissionless; ticket + chain clock authorize)
pub struct InstructionData<'a> {
    data: &'a [u8],
}

impl<'a> InstructionData<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, ProgramError> {
        Ok(Self { data })
    }

    pub fn read_u64_at(&self, offset: usize) -> Result<u64, ProgramError> {
        let bytes = self
            .data
            .get(offset..offset + 8)
            .ok_or(ProgramError::InvalidInstructionData)?;
        Ok(u64::from_le_bytes(bytes.try_into().expect("8 bytes")))
    }

    pub fn read_u16_at(&self, offset: usize) -> Result<u16, ProgramError> {
        let bytes = self
            .data
            .get(offset..offset + 2)
            .ok_or(ProgramError::InvalidInstructionData)?;
        Ok(u16::from_le_bytes(bytes.try_into().expect("2 bytes")))
    }

    pub fn read_array<const N: usize>(&self, offset: usize) -> Result<[u8; N], ProgramError> {
        self.data
            .get(offset..offset + N)
            .ok_or(ProgramError::InvalidInstructionData)?
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)
    }

    pub fn read_bytes(&self, offset: usize, len: usize) -> Result<&[u8], ProgramError> {
        self.data
            .get(offset..offset + len)
            .ok_or(ProgramError::InvalidInstructionData)
    }
}