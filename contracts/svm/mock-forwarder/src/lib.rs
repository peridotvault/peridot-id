//! Adversarial test helper (never deployed beyond localnet tests).
//!
//! Forwards whatever accounts it receives — with their caller-granted signer
//! bits — to a third program via plain `invoke` (no seeds of its own). This is
//! exactly what a malicious game program would do with a lent signer status:
//! the test suite proves what such forwarding can and cannot move.

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use pinocchio::{account::AccountView, error::ProgramError, program_entrypoint, Address, ProgramResult};

pinocchio::default_allocator!();
pinocchio::nostd_panic_handler!();

program_entrypoint!(process_instruction);

/// Data: `target[32] | inner_len u16 | inner_data | count u8 |
/// accounts count×(addr[32] ‖ is_signer u8 ‖ is_writable u8)`.
pub fn process_instruction(
    _program_id: &Address,
    accounts: &[AccountView],
    data: &[u8],
) -> ProgramResult {
    let get = |off: usize, len: usize| data.get(off..off + len).ok_or(ProgramError::InvalidInstructionData);
    let target: [u8; 32] = get(0, 32)?.try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let inner_len = u16::from_le_bytes(get(32, 2)?.try_into().map_err(|_| ProgramError::InvalidInstructionData)?) as usize;
    let inner = get(34, inner_len)?;
    let mut cursor = 34 + inner_len;
    let count = *get(cursor, 1)?.first().ok_or(ProgramError::InvalidInstructionData)? as usize;
    cursor += 1;
    let mut addrs: Vec<Address> = Vec::with_capacity(count);
    let mut flags: Vec<(bool, bool)> = Vec::with_capacity(count);
    let mut views = Vec::with_capacity(count);
    for _ in 0..count {
        let addr: [u8; 32] = get(cursor, 32)?.try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
        let is_signer = get(cursor + 32, 1)?[0] != 0;
        let is_writable = get(cursor + 33, 1)?[0] != 0;
        cursor += 34;
        let view = accounts
            .iter()
            .find(|v| v.address().as_array() == &addr)
            .ok_or(ProgramError::NotEnoughAccountKeys)?;
        addrs.push(Address::new_from_array(addr));
        flags.push((is_writable, is_signer));
        views.push(view);
    }
    let metas: Vec<pinocchio::instruction::InstructionAccount> = addrs
        .iter()
        .zip(flags.iter())
        .map(|(addr, (writable, signer))| {
            pinocchio::instruction::InstructionAccount::new(addr, *writable, *signer)
        })
        .collect();
    let target_addr = Address::new_from_array(target);
    pinocchio_log::log!("FWD entered");
    let ix = pinocchio::instruction::InstructionView {
        program_id: &target_addr,
        data: inner,
        accounts: &metas,
    };
    // Plain invoke: no signer seeds. Any signer bit forwarded here survives
    // only if this program received it — the runtime decides, not us.
    pinocchio::cpi::invoke_signed_with_slice(&ix, &views, &[])?;
    pinocchio_log::log!("FWD inner ok");
    Ok(())
}
