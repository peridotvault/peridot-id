//! Rotate the smart account authority, V5 authorization (ANT-868 B4).
//!
//! V5 sibling of `update_authority` (which stays frozen): identical
//! instruction layout and flow, but the passkey signs the V5
//! domain-separated payload
//! (op-tag ‖ program_id ‖ cluster_id ‖ account_id ‖ nonce ‖ new authority ‖
//! expiry). The program recomputes `program_id` from its own entrypoint
//! argument (spoof-proof) and `cluster_id` from the build-baked
//! [`crate::CLUSTER_ID`] (`PID_CLUSTER_ID`, the cluster's genesis hash), so
//! the assertion verifies on exactly one (program, cluster) pair — the same
//! bytes submitted to a second cluster fail with `InvalidChallenge`.
//!
//! Rotation still rewrites key bytes only (the PDA never moves) and still
//! rejects the zero key. NOTE (B3 merge follow-up): when the ANT-863 B3
//! epoch lands on `paperclip`, this path must saturating-bump the vault
//! session-generation exactly like `update_authority` — otherwise a V5
//! rotation would not revoke sessions. Tracked in the ANT-868 child issue.

use crate::{
    auth,
    errors::PeridotError,
    state::{verify_nonce, verify_pda, SmartAccount, SmartAccountMut, AUTHORITY_LEN},
    CLUSTER_ID,
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

use super::InstructionData;

/// Instruction data layout (identical to V3 `update_authority`):
/// `nonce u64 | new_authority [u8; 33] | expiry i64 | client_json_len u16 | clientDataJSON`.
const NONCE_OFFSET: usize = 0;
const NEW_AUTHORITY_OFFSET: usize = 8;
const EXPIRY_OFFSET: usize = 8 + 33;
const CLIENT_JSON_LEN_OFFSET: usize = 8 + 33 + 8;

/// Accounts:
///   0. `[WRITE]` smart account PDA
///   1. `[]` instructions sysvar
pub fn process(
    program_id: &Address,
    accounts: &[AccountView],
    data: &InstructionData,
) -> ProgramResult {
    if accounts.len() < 2 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let smart_account = &accounts[0];
    let instructions = &accounts[1];

    if !smart_account.owned_by(program_id) {
        return Err(PeridotError::WrongOwner.into());
    }
    if smart_account.data_len() == 0 {
        return Err(PeridotError::Uninitialized.into());
    }

    let nonce = data.read_u64_at(NONCE_OFFSET)?;
    let new_authority = data.read_array::<33>(NEW_AUTHORITY_OFFSET)?;
    let expiry = i64::from_le_bytes(data.read_array::<8>(EXPIRY_OFFSET)?);
    let client_json_len = u16::from_le_bytes(data.read_array::<2>(CLIENT_JSON_LEN_OFFSET)?) as usize;
    let client_json = data
        .read_bytes(CLIENT_JSON_LEN_OFFSET + 2, client_json_len)?;

    if new_authority == [0u8; AUTHORITY_LEN] {
        return Err(PeridotError::Unauthorized.into());
    }

    let (current_authority, account_id, key_hash) = {
        let borrowed = smart_account.try_borrow()?;
        let state = SmartAccount::try_from_bytes(&borrowed)?;
        state.require_active()?;
        verify_nonce(&state, nonce)?;
        (state.authority(), state.account_id(), state.key_hash())
    };
    verify_pda(smart_account, program_id, account_id, key_hash)?;

    let payload = auth::payload_hash_v5(&[
        &[auth::OP_UPDATE_AUTHORITY_V5],
        program_id.as_array(),
        &CLUSTER_ID,
        &account_id,
        &nonce.to_le_bytes(),
        &new_authority,
        &expiry.to_le_bytes(),
    ]);
    auth::check_expiry(expiry)?;
    auth::verify_secp256r1_v2(instructions, &current_authority, client_json, &payload)?;

    debug_assert_eq!(new_authority.len(), AUTHORITY_LEN);
    let mut data_ref = smart_account.try_borrow_mut()?;
    let mut state = SmartAccountMut::try_from_bytes(&mut data_ref)?;
    state.set_authority(new_authority);
    state.increment_nonce();
    drop(data_ref);

    pinocchio_log::log!("PeridotEvent::AuthorityUpdated");
    Ok(())
}
