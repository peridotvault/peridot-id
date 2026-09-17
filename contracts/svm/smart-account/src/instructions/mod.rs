//! Instruction definitions and dispatch.

use pinocchio::error::ProgramError;

pub mod activate;
pub mod close;
pub mod close_session;
pub mod execute;
pub mod initialize;
pub mod register_session;
pub mod revoke_session;
pub mod session_execute;
pub mod update_authority;
pub mod withdraw_sol;
pub mod withdraw_token;

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
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// Fixed-layout V3 instruction payload after the discriminator byte.
///
/// Layouts (all multi-byte integers little-endian; `network_fee` is the backend-
/// attested realtime network cost — the program recomputes the protocol fee from
/// the signed policy version, never trusting a caller-supplied total):
/// - Initialize:      account_id [u8; 32] | authority [u8; 33] | rp_id_hash [u8; 32] | len u16 | clientDataJSON
/// - WithdrawSol:     nonce u64 | amount u64 | destination [u8; 32] | expiry i64 | policy u16 | network_fee u64 | len u16 | clientDataJSON
/// - WithdrawToken:   nonce u64 | amount u64 | destination_ata [u8; 32] | expiry i64 | policy u16 | network_fee u64 | len u16 | clientDataJSON
/// - UpdateAuthority: nonce u64 | new_authority [u8; 33] | expiry i64 | len u16 | clientDataJSON
/// - Close:           nonce u64 | expiry i64 | len u16 | clientDataJSON
/// - Activate:        account_id [u8; 32] | authority [u8; 33] | rp_id_hash [u8; 32] | policy u16 | expiry i64 | network_fee u64 | len u16 | clientDataJSON
/// - Execute:         nonce u64 | target [u8; 32] | meta_count u8 | metas meta_count×(addr[32] ‖ flags u8) | data_len u16 | data | expiry i64 | policy u16 | network_fee u64 | len u16 | clientDataJSON
/// Every V3 authorization payload starts with the one-byte op-tag (`auth::OP_*`,
/// equal to the discriminator) followed by `account_id`, so a signature for one
/// operation or one account can never authorize another. Fee recipients are
/// canonical (`config::TREASURY` revenue vault for the protocol fee, the relayer
/// signer for the exact network-cost reimbursement) — no per-call treasury.
/// The `len u16` prefixes the raw WebAuthn clientDataJSON passed for on-chain
/// verification.
/// Withdraws/activations are relayer-sponsored: `protocol_fee` is recomputed as
/// `floor(network_fee × bps / 10_000)` per the signed fee-policy version.
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