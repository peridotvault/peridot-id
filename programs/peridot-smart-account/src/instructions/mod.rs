//! Instruction definitions and dispatch.

use pinocchio::error::ProgramError;

pub mod activate;
pub mod close;
pub mod initialize;
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
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// Fixed-layout instruction payload after the discriminator byte.
///
/// Layouts:
/// - Initialize:      account_id [u8; 32] | authority [u8; 33]
/// - WithdrawSol:     nonce u64 | amount u64 | destination [u8; 32] | expiry i64 | len u16 | clientDataJSON
/// - WithdrawToken:   nonce u64 | amount u64 | destination_ata [u8; 32] | expiry i64 | len u16 | clientDataJSON
/// - UpdateAuthority: nonce u64 | new_authority [u8; 33] | expiry i64 | len u16 | clientDataJSON
/// - Close:           nonce u64 | expiry i64 | len u16 | clientDataJSON
/// - Activate:        account_id [u8; 32] | authority [u8; 33] | activation_fee u64
/// The `len u16` prefixes the raw WebAuthn clientDataJSON passed for on-chain verification.
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