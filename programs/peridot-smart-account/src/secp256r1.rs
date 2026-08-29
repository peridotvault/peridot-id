//! Deserializer for the Solana Secp256r1 signature-verification precompile instruction.
//!
//! Vendored from `pinocchio-secp256r1-instruction` (MIT, Dean Little / Blueshift) and
//! adapted to pinocchio 0.10's re-exports (`error::ProgramError`, `address::Address`).
//! Enables the instruction-sysvar introspection pattern for passkey (secp256r1) authority
//! verification (ADR 005 Option B).

#![allow(clippy::missing_safety_doc)]

use pinocchio::{
    error::ProgramError, sysvars::instructions::IntrospectedInstruction, Address,
};

// Secp256r1SigVerify1111111111111111111111111
pub const SECP256R1_PROGRAM_ID: Address = Address::new_from_array([
    0x06, 0x92, 0x0d, 0xec, 0x2f, 0xea, 0x71, 0xb5, 0xb7, 0x23, 0x81, 0x4d, 0x74, 0x2d, 0xa9, 0x03,
    0x1c, 0x83, 0xe7, 0x5f, 0xdb, 0x79, 0x5d, 0x56, 0x8e, 0x75, 0x47, 0x80, 0x20, 0x00, 0x00, 0x00,
]);
pub const SECP256R1_SIGNATURE_LENGTH: usize = 64;
pub const SECP256R1_COMPRESSED_PUBKEY_LENGTH: usize = 33;

pub type Secp256r1Pubkey = [u8; SECP256R1_COMPRESSED_PUBKEY_LENGTH];
pub type Secp256r1Signature = [u8; SECP256R1_SIGNATURE_LENGTH];

pub struct Secp256r1Instruction<'a> {
    header: Secp256r1InstructionHeader,
    offsets: &'a [Secp256r1SignatureOffsets],
    data: &'a [u8],
}

impl<'a> TryFrom<&'a [u8]> for Secp256r1Instruction<'a> {
    type Error = ProgramError;

    fn try_from(data: &'a [u8]) -> Result<Self, Self::Error> {
        // We can skip this check, as it's done by the Secp256r1 Program
        #[cfg(not(feature = "perf"))]
        if data.len() < 2 {
            return Err(ProgramError::InvalidInstructionData);
        }

        let header: Secp256r1InstructionHeader = unsafe { core::mem::transmute([data[0]]) };

        #[cfg(not(feature = "perf"))]
        if data.len()
            < 2 + (header.num_signatures as usize
                * core::mem::size_of::<Secp256r1SignatureOffsets>())
        {
            return Err(ProgramError::InvalidInstructionData);
        }

        let offsets = unsafe {
            core::slice::from_raw_parts::<Secp256r1SignatureOffsets>(
                data.as_ptr().add(2) as *const Secp256r1SignatureOffsets,
                header.num_signatures as usize,
            )
        };

        Ok(Secp256r1Instruction {
            header,
            offsets,
            data,
        })
    }
}

impl<'a> TryFrom<&'a IntrospectedInstruction<'a>> for Secp256r1Instruction<'a> {
    type Error = ProgramError;

    fn try_from(ix: &'a IntrospectedInstruction<'a>) -> Result<Self, Self::Error> {
        if SECP256R1_PROGRAM_ID.ne(ix.get_program_id()) {
            return Err(ProgramError::IncorrectProgramId);
        }
        Self::try_from(ix.get_instruction_data())
    }
}

#[repr(C, packed)]
pub struct Secp256r1InstructionHeader {
    pub num_signatures: u8,
}

#[repr(C, packed)]
pub struct Secp256r1SignatureOffsets {
    pub signature_offset: u16,
    pub signature_instruction_index: u16,
    pub public_key_offset: u16,
    pub public_key_instruction_index: u16,
    pub message_data_offset: u16,
    pub message_data_size: u16,
    pub message_instruction_index: u16,
}

impl<'a> Secp256r1Instruction<'a> {
    /// Get the number of signatures in this instruction
    #[inline(always)]
    pub fn num_signatures(&self) -> u8 {
        self.header.num_signatures
    }

    /// Get the signer (public key) at the specified index
    #[inline(always)]
    pub fn get_signer(&self, index: usize) -> Result<&Secp256r1Pubkey, ProgramError> {
        if index >= self.header.num_signatures as usize {
            return Err(ProgramError::InvalidArgument);
        }

        let offset = &self.offsets[index];

        // Only support local instruction data for now
        if offset.public_key_instruction_index != u16::MAX {
            return Err(ProgramError::InvalidInstructionData);
        }

        offset.get_signer(self.data)
    }

    /// Get the signature at the specified index
    #[inline(always)]
    pub fn get_signature(&self, index: usize) -> Result<&Secp256r1Signature, ProgramError> {
        if index >= self.header.num_signatures as usize {
            return Err(ProgramError::InvalidArgument);
        }

        let offset = &self.offsets[index];

        // Only support local instruction data for now
        if offset.signature_instruction_index != u16::MAX {
            return Err(ProgramError::InvalidInstructionData);
        }

        offset.get_signature(self.data)
    }

    /// Get the message data at the specified index
    #[inline(always)]
    pub fn get_message_data(&self, index: usize) -> Result<&[u8], ProgramError> {
        if index >= self.header.num_signatures as usize {
            return Err(ProgramError::InvalidArgument);
        }

        let offset = &self.offsets[index];

        // Only support local instruction data for now
        if offset.message_instruction_index != u16::MAX {
            return Err(ProgramError::InvalidInstructionData);
        }

        offset.get_message_data(self.data)
    }
}

impl Secp256r1SignatureOffsets {
    /// Get the public key from local instruction data
    #[inline(always)]
    pub fn get_signer(&self, data: &[u8]) -> Result<&Secp256r1Pubkey, ProgramError> {
        let start = self.public_key_offset as usize;
        let end = start + SECP256R1_COMPRESSED_PUBKEY_LENGTH;

        if end > data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }

        let slice = &data[start..end];
        Ok(unsafe { &*(slice.as_ptr() as *const Secp256r1Pubkey) })
    }

    /// Get the signature from local instruction data
    #[inline(always)]
    pub fn get_signature(&self, data: &[u8]) -> Result<&Secp256r1Signature, ProgramError> {
        let start = self.signature_offset as usize;
        let end = start + SECP256R1_SIGNATURE_LENGTH;

        if end > data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }

        let slice = &data[start..end];
        Ok(unsafe { &*(slice.as_ptr() as *const Secp256r1Signature) })
    }

    /// Get the message data from local instruction data
    #[inline(always)]
    pub fn get_message_data<'a>(&self, data: &'a [u8]) -> Result<&'a [u8], ProgramError> {
        let start = self.message_data_offset as usize;
        let end = start + self.message_data_size as usize;

        if end > data.len() {
            return Err(ProgramError::InvalidInstructionData);
        }

        Ok(&data[start..end])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{vec, vec::Vec};

    /// Instruction: 1 signature, pubkey@16 (33B), sig@49 (64B), message@113 (6B).
    fn sample_ix() -> Vec<u8> {
        let mut d = vec![0u8; 119];
        d[0] = 1; // num_signatures
        d[2..4].copy_from_slice(&49u16.to_le_bytes()); // signature_offset
        d[4..6].copy_from_slice(&u16::MAX.to_le_bytes());
        d[6..8].copy_from_slice(&16u16.to_le_bytes()); // pubkey_offset
        d[8..10].copy_from_slice(&u16::MAX.to_le_bytes());
        d[10..12].copy_from_slice(&113u16.to_le_bytes()); // message_data_offset
        d[12..14].copy_from_slice(&6u16.to_le_bytes()); // message_data_size
        d[14..16].copy_from_slice(&u16::MAX.to_le_bytes());
        d[16] = 0x02; // even-y compressed pubkey
        for (i, b) in d[17..49].iter_mut().enumerate() {
            *b = (i + 1) as u8;
        }
        d[49..113].fill(0xaa); // signature
        d[113..119].copy_from_slice(b"abcdef"); // message
        d
    }

    #[test]
    fn parses_offsets_and_extracts_fields() {
        let sample = sample_ix();
        let ix = Secp256r1Instruction::try_from(&sample[..]).unwrap();
        assert_eq!(ix.num_signatures(), 1);
        assert_eq!(ix.get_signer(0).unwrap()[0], 0x02);
        assert_eq!(ix.get_signature(0).unwrap().len(), 64);
        assert_eq!(ix.get_message_data(0).unwrap(), b"abcdef");
    }

    #[test]
    fn rejects_bad_length() {
        assert!(Secp256r1Instruction::try_from(&[0x01][..]).is_err());
        assert!(Secp256r1Instruction::try_from(&[][..]).is_err());
    }

    #[test]
    fn rejects_out_of_bounds_index() {
        let sample = sample_ix();
        let ix = Secp256r1Instruction::try_from(&sample[..]).unwrap();
        assert!(ix.get_signer(1).is_err());
    }
}