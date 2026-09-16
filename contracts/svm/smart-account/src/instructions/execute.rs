//! Generic CPI execution, V3 authorization (authorized by a secp256r1 passkey).
//!
//! Wallet parity with the EVM `execute`: one passkey-signed intent drives an
//! arbitrary call — here a cross-program invocation with the smart-account PDA
//! as signer. Fully generic + minimal deny-list: any target program except this
//! program itself (no reentrancy). Token-2022 works with zero extra code — the
//! target program ID is just bytes.
//!
//! Relayer-substitution resistance comes from `call_hash`: the passkey signs
//! `sha256` over the exact target ‖ metas ‖ data bytes, so the relayer cannot
//! swap the call under a valid signature. The CPI layer additionally enforces
//! address match (bound meta address vs passed account) and privilege bounds.
//! The PDA must appear in the metas with the signer bit — the signed
//! authorization must actually delegate the account, never bless a noop.
//! Fees settle exactly like withdrawals: `network_fee` → relayer signer,
//! recomputed protocol fee → canonical revenue vault.

use crate::{
    auth,
    config::TREASURY,
    errors::PeridotError,
    fee::{policy_protocol_bps, split_attested_fee, total_fee},
    state::{verify_nonce, verify_pda, SmartAccount, SmartAccountMut},
};
use alloc::vec::Vec;
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout:
/// `nonce u64 | target_program [u8; 32] | meta_count u8 | metas meta_count×(addr[32] ‖ flags u8)
///  | data_len u16 | data | expiry i64 | policy u16 | network_fee u64 | client_json_len u16 | clientDataJSON`.
///
/// Meta flags: bit 0 = writable, bit 1 = signer. This exact byte encoding is
/// also the `call_hash` input (target_program through end of data), so the SDK
/// serializes once and hashes the same bytes the program verifies.
const NONCE_OFFSET: usize = 0;
const TARGET_OFFSET: usize = 8;
const META_COUNT_OFFSET: usize = 40;
const METAS_OFFSET: usize = 41;
const META_LEN: usize = 33;
const FLAG_WRITABLE: u8 = 0x01;
const FLAG_SIGNER: u8 = 0x02;

/// Protocol-level caps (the transaction size limit binds first in practice).
pub const MAX_EXECUTE_METAS: usize = 64;
pub const MAX_EXECUTE_DATA: usize = 10_240;

/// Accounts:
///   0. `[WRITE]` smart account PDA (signs the CPI via seeds)
///   1. `[WRITE, SIGNER]` relayer (pays the network fee; receives the exact reimbursement)
///   2. `[WRITE]` canonical revenue vault (receives the protocol fee; must equal `config::TREASURY`)
///   3. `[]` target program (must not be this program)
///   4. `[]` instructions sysvar (for secp256r1 introspection)
///   5.. remaining accounts, covering each non-PDA meta in order (privileges ≥ the
///       bound flags). The PDA is NOT repeated here — outer transactions deduplicate
///       it — bound PDA metas map back to account 0.
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let smart_account = &accounts[0];
    let relayer = &accounts[1];
    let treasury = &accounts[2];
    let instructions = &accounts[4];

    if !relayer.is_signer() {
        return Err(PeridotError::NotSigner.into());
    }
    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }
    if treasury.address().as_array() != &TREASURY {
        return Err(PeridotError::InvalidDestination.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let target_bytes = data.read_array::<32>(TARGET_OFFSET)?;
    let meta_count = *data
        .read_bytes(META_COUNT_OFFSET, 1)?
        .first()
        .ok_or(ProgramError::InvalidInstructionData)? as usize;
    if meta_count > MAX_EXECUTE_METAS {
        return Err(ProgramError::InvalidInstructionData);
    }

    let target_addr = Address::new_from_array(target_bytes);
    if &target_addr == program_id {
        return Err(PeridotError::InvalidTarget.into());
    }
    // The outer keys must name the bound target at its fixed position — the CPI
    // below loads the program from instruction data, never from accounts.
    if accounts[3].address() != &target_addr {
        return Err(PeridotError::InvalidDestination.into());
    }

    // The PDA must delegate itself as a signer of the inner call; collect the
    // bound metas in one pass (addresses + flags feed the CPI below).
    let mut pda_signs = false;
    let mut metas: Vec<([u8; 32], u8)> = Vec::with_capacity(meta_count);
    let mut off = METAS_OFFSET;
    for _ in 0..meta_count {
        let addr = data.read_array::<32>(off)?;
        let flags = *data
            .read_bytes(off + 32, 1)?
            .first()
            .ok_or(ProgramError::InvalidInstructionData)?;
        if addr == *smart_account.address().as_array() && flags & FLAG_SIGNER != 0 {
            pda_signs = true;
        }
        metas.push((addr, flags));
        off += META_LEN;
    }
    if !pda_signs {
        return Err(PeridotError::Unauthorized.into());
    }

    // Remaining accounts cover each non-PDA meta exactly once, in order. The PDA
    // is never repeated (outer transactions deduplicate it) — bound PDA metas
    // map back to account 0.
    let non_pda = metas
        .iter()
        .filter(|(addr, _)| addr != smart_account.address().as_array())
        .count();
    if accounts.len() != 5 + non_pda {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let data_len = u16::from_le_bytes(data.read_array::<2>(off)?) as usize;
    if data_len > MAX_EXECUTE_DATA {
        return Err(ProgramError::InvalidInstructionData);
    }
    let call_end = off + 2;
    let call_bytes = data.read_bytes(TARGET_OFFSET, call_end + data_len - TARGET_OFFSET)?;
    let call_data = data.read_bytes(call_end, data_len)?;
    let mut cursor = call_end + data_len;
    let expiry = i64::from_le_bytes(data.read_array::<8>(cursor)?);
    cursor += 8;
    let policy_version = data.read_u16_at(cursor)?;
    cursor += 2;
    let network_fee = data.read_u64_at(cursor)?;
    cursor += 8;
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(cursor)?) as usize;
    let client_json = data.read_bytes(cursor + 2, client_json_len)?;

    let (authority, account_id, rp_id_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.rp_id_hash()?)
    };
    let bump = verify_pda(smart_account, program_id, account_id)?;

    let call_hash = auth::sha256(call_bytes);
    let payload = auth::payload_hash_v3(&[
        &[auth::OP_EXECUTE],
        &account_id,
        &nonce.to_le_bytes(),
        &expiry.to_le_bytes(),
        &policy_version.to_le_bytes(),
        &call_hash,
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, &rp_id_hash, client_json, &payload)?;

    let bps = policy_protocol_bps(policy_version)?;
    let (relayer_fee, protocol_fee) = split_attested_fee(network_fee, bps);
    let total = total_fee(relayer_fee, protocol_fee);
    if smart_account.lamports() < total || total < network_fee {
        return Err(PeridotError::InsufficientFunds.into());
    }

    // All state borrows are dropped above; build the CPI from the bound metas.
    let signer_seeds = [bump];
    let seeds = [
        pinocchio::cpi::Seed::from(b"peridot_id".as_slice()),
        pinocchio::cpi::Seed::from(b"account".as_slice()),
        pinocchio::cpi::Seed::from(account_id.as_slice()),
        pinocchio::cpi::Seed::from(signer_seeds.as_slice()),
    ];
    let signer = pinocchio::cpi::Signer::from(&seeds[..]);

    let mut cpi_addresses: Vec<Address> = Vec::with_capacity(meta_count);
    let mut cpi_views: Vec<&AccountView> = Vec::with_capacity(meta_count);
    let mut cursor = 5usize;
    for (addr, _) in metas.iter() {
        let parsed = Address::new_from_array(*addr);
        if &parsed == smart_account.address() {
            // Deduplicated outer account: the PDA meta reuses account 0, which
            // gains its signer bit inside the CPI via the seeds below.
            cpi_views.push(smart_account);
        } else {
            let view = accounts.get(cursor).ok_or(ProgramError::NotEnoughAccountKeys)?;
            // Address match is re-enforced by the CPI layer; fail here with the
            // clearer error when the relayer reorders accounts.
            if view.address() != &parsed {
                return Err(PeridotError::InvalidDestination.into());
            }
            cpi_views.push(view);
            cursor += 1;
        }
        cpi_addresses.push(parsed);
    }
    let cpi_metas: Vec<pinocchio::instruction::InstructionAccount> = cpi_addresses
        .iter()
        .zip(metas.iter())
        .map(|(addr, (_, flags))| {
            pinocchio::instruction::InstructionAccount::new(
                addr,
                flags & FLAG_WRITABLE != 0,
                flags & FLAG_SIGNER != 0,
            )
        })
        .collect();
    let cpi_ix = pinocchio::instruction::InstructionView {
        program_id: &target_addr,
        data: call_data,
        accounts: &cpi_metas,
    };
    pinocchio::cpi::invoke_signed_with_slice(&cpi_ix, &cpi_views, &[signer])?;

    // Settle fees after the call (atomic revert on CPI failure regardless).
    let from = *smart_account;
    let t = *treasury;
    let r = *relayer;
    r.set_lamports(r.lamports() + relayer_fee);
    t.set_lamports(t.lamports() + protocol_fee);
    from.set_lamports(from.lamports() - total);

    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.increment_nonce();
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::TransactionExecuted");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth;

    /// Shared vector with `execute-call.spec.ts` (SDK) — pins SDK↔program byte
    /// parity for `call_hash` and the V3 execute payload. If either side changes
    /// its serialization, both tests fail together.
    #[test]
    fn execute_call_hash_and_payload_match_sdk_vector() {
        let target = [0x07u8; 32];
        let m1 = [0x11u8; 32];
        let m2 = [0x33u8; 32];
        let m3 = [0x44u8; 32];
        let inner: [u8; 9] = [3, 100, 0, 0, 0, 0, 0, 0, 0];
        // target ‖ count ‖ metas(addr ‖ flags) ‖ data_len ‖ data
        let mut call = alloc::vec::Vec::new();
        call.extend_from_slice(&target);
        call.push(3);
        call.extend_from_slice(&m1);
        call.push(FLAG_WRITABLE);
        call.extend_from_slice(&m2);
        call.push(0);
        call.extend_from_slice(&m3);
        call.push(FLAG_SIGNER);
        call.extend_from_slice(&(inner.len() as u16).to_le_bytes());
        call.extend_from_slice(&inner);
        assert_eq!(
            call,
            [
                7u8, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7,
                7, 7, 7, 7, 3, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17,
                17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 1, 51, 51, 51, 51, 51, 51, 51,
                51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51, 51,
                51, 51, 51, 0, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68,
                68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 68, 2, 9, 0, 3, 100, 0, 0, 0, 0,
                0, 0, 0,
            ]
        );
        let call_hash = auth::sha256(&call);
        assert_eq!(
            call_hash,
            [
                0xec, 0x7e, 0x18, 0x88, 0x59, 0xbc, 0x7d, 0x9d, 0x97, 0xbe, 0x64, 0x08, 0xf5, 0x78,
                0x8c, 0x89, 0x4d, 0x0f, 0x89, 0xfa, 0x98, 0x9c, 0x7e, 0x8b, 0x08, 0xd0, 0x33, 0xa6,
                0xbf, 0x97, 0xa2, 0xfa,
            ]
        );
        let account_id = [0x22u8; 32];
        let payload = auth::payload_hash_v3(&[
            &[auth::OP_EXECUTE],
            &account_id,
            &7u64.to_le_bytes(),
            &1_700_000_000i64.to_le_bytes(),
            &1u16.to_le_bytes(),
            &call_hash,
        ]);
        assert_eq!(auth::OP_EXECUTE, 6);
        assert_eq!(
            payload,
            [
                0x06, 0x26, 0xbd, 0x30, 0x39, 0x3c, 0xcf, 0xb8, 0xa0, 0xb6, 0x94, 0xbd, 0xf6, 0x53,
                0xe7, 0x86, 0x34, 0xb2, 0xa7, 0x68, 0x39, 0x22, 0x7e, 0x24, 0xc5, 0xe6, 0x9d, 0xa0,
                0x2d, 0xcc, 0x03, 0x41,
            ]
        );
    }
}
