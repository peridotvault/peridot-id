//! Generic CPI execution, V5 authorization (ANT-868 B4).
//!
//! V5 sibling of `execute` (which stays frozen): identical instruction layout,
//! call-hash confinement, PDA-signer and fee flow, but the passkey signs the
//! V5 domain-separated payload
//! (op-tag ‖ program_id ‖ cluster_id ‖ account_id ‖ nonce ‖ expiry ‖ policy ‖
//! call_hash). The program recomputes `program_id` from its own entrypoint
//! argument (spoof-proof) and `cluster_id` from the build-baked
//! [`crate::CLUSTER_ID`] (`PID_CLUSTER_ID`, the cluster's genesis hash), so
//! the assertion verifies on exactly one (program, cluster) pair — the same
//! bytes submitted to a second cluster fail with `InvalidChallenge`.
//!
//! Relayer-substitution resistance, effects-before-interactions (nonce burn
//! before the CPI) and fee settlement are unchanged from `execute`.

use crate::{
    auth,
    errors::PeridotError,
    fee::{policy_protocol_bps, split_attested_fee, total_fee},
    state::{verify_nonce, verify_pda, SmartAccount, SmartAccountMut},
    treasury::verify_treasury_pda,
    CLUSTER_ID,
};
use alloc::vec::Vec;
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout (identical to V3 `execute`):
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
///   2. `[WRITE]` canonical revenue vault (receives the protocol fee; must be the `[b"treasury"]` PDA vault (ANT-635))
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
    // ANT-635 (ANT-638): the protocol fee lands in the program-bound PDA vault
    // `[b"treasury"]` (verified against the runtime program_id), not the
    // build-baked `config::TREASURY` const (removed). Fee math unchanged (D5).
    verify_treasury_pda(treasury, program_id)?;

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

    let (authority, account_id, key_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        state.require_active()?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.key_hash())
    };
    let bump = verify_pda(smart_account, program_id, account_id, key_hash)?;

    let call_hash = auth::sha256(call_bytes);
    let payload = auth::payload_hash_v5(&[
        &[auth::OP_EXECUTE_V5],
        program_id.as_array(),
        &CLUSTER_ID,
        &account_id,
        &nonce.to_le_bytes(),
        &expiry.to_le_bytes(),
        &policy_version.to_le_bytes(),
        &call_hash,
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &authority, client_json, &payload)?;

    let bps = policy_protocol_bps(policy_version)?;
    let (relayer_fee, protocol_fee) = split_attested_fee(network_fee, bps);
    let total = total_fee(relayer_fee, protocol_fee);
    if smart_account.lamports() < total || total < network_fee {
        return Err(PeridotError::InsufficientFunds.into());
    }

    // Effects first (checks-effects-interactions): burn the nonce BEFORE the
    // untrusted CPI (same rationale as `execute`).
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.increment_nonce();
    drop(data_ref);

    // All state borrows are dropped above; build the CPI from the bound metas.
    let signer_seeds = [bump];
    let seeds = [
        pinocchio::cpi::Seed::from(b"peridot_id".as_slice()),
        pinocchio::cpi::Seed::from(b"account".as_slice()),
        pinocchio::cpi::Seed::from(account_id.as_slice()),
        pinocchio::cpi::Seed::from(key_hash.as_slice()),
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
    // The nonce was already burned above (effects-before-interactions).
    let from = *smart_account;
    let t = *treasury;
    let r = *relayer;
    r.set_lamports(r.lamports() + relayer_fee);
    t.set_lamports(t.lamports() + protocol_fee);
    from.set_lamports(from.lamports() - total);

    pinocchio_log::log!("PeridotEvent::TransactionExecuted");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth;

    /// V5 execute payload vector — pins program/cluster binding byte parity
    /// with the SDK (`executeV5Payload` in `@peridotvault/pid-solana`). The
    /// program id and cluster id below are arbitrary test constants.
    #[test]
    fn execute_v5_payload_binds_program_and_cluster() {
        let program = [0x77u8; 32];
        let cluster = [0x5au8; 32];
        let account_id = [0x22u8; 32];
        let call_hash = [0xccu8; 32];
        let payload = auth::payload_hash_v5(&[
            &[auth::OP_EXECUTE_V5],
            &program,
            &cluster,
            &account_id,
            &7u64.to_le_bytes(),
            &1_700_000_000i64.to_le_bytes(),
            &1u16.to_le_bytes(),
            &call_hash,
        ]);
        assert_eq!(auth::OP_EXECUTE_V5, 21);
        // Reference computation: sha256(DOMAIN_V5 ‖ parts).
        let mut buf = alloc::vec::Vec::new();
        buf.extend_from_slice(auth::DOMAIN_V5);
        buf.extend_from_slice(&[auth::OP_EXECUTE_V5]);
        buf.extend_from_slice(&program);
        buf.extend_from_slice(&cluster);
        buf.extend_from_slice(&account_id);
        buf.extend_from_slice(&7u64.to_le_bytes());
        buf.extend_from_slice(&1_700_000_000i64.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&call_hash);
        assert_eq!(payload, auth::sha256(&buf));
        // The same tail under the V3 domain must differ.
        let v3 = auth::payload_hash_v3(&[
            &[auth::OP_EXECUTE],
            &account_id,
            &7u64.to_le_bytes(),
            &1_700_000_000i64.to_le_bytes(),
            &1u16.to_le_bytes(),
            &call_hash,
        ]);
        assert_ne!(payload, v3);
    }
}
