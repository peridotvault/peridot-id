//! secp256r1 passkey authorization verification (ADR 005 Option B — Tier B).
//!
//! The wallet authority is a WebAuthn passkey (secp256r1 / P-256). Its assertion signature
//! covers `authenticatorData ‖ sha256(clientDataJSON)`. The SDK builds a Secp256r1
//! precompile instruction carrying that message plus the recovered 33-byte compressed
//! public key, placed immediately AFTER this program's instruction in the transaction.
//! The program introspects it via the Instructions sysvar and verifies:
//!
//! 1. the recovered public key equals the stored authority (the passkey owns the account);
//! 2. the signed message is exactly `authenticatorData ‖ sha256(clientDataJSON)`
//!    where `clientDataJSON` is a program argument (binds the exact bytes the
//!    passkey attested);
//! 3. `authenticatorData[0:32]` equals the stored RP-ID hash and the user-verification
//!    flag (`0x04`) is set — the same semantics the EVM counterpart enforces;
//! 4. the `"challenge"` inside `clientDataJSON` decodes to the V2 authorization
//!    payload the program recomputes from its own arguments (domain ‖ op-tag ‖
//!    account ‖ action ‖ expiry ‖ fee cap) — preventing transaction substitution;
//! 5. the expiry has not passed and is not further in the future than `MAX_TTL_SECS`
//!    (Clock sysvar) — bounding cross-cluster replay of an otherwise-valid signature.

use crate::errors::PeridotError;
use crate::secp256r1::Secp256r1Instruction;
use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, instructions::Instructions, Sysvar},
    AccountView,
};

/// Domain separator for the V1 signed authorization payload (frozen, legacy).
pub const DOMAIN: &[u8] = b"PID|SOLANA|SMART_ACCOUNT|v1";
/// Domain separator for the V2 signed authorization payload (frozen, legacy).
/// V1 signatures can never verify as V2: the domain differs and every V2 payload
/// additionally starts with an explicit operation tag byte.
pub const DOMAIN_V2: &[u8] = b"PID|SOLANA|SMART_ACCOUNT|v2";
/// Domain separator for the V3 signed authorization payload (canonical).
/// V2 signatures can never verify as V3: the domain differs. V3 drops all
/// amount fields from payloads — only the fee-policy version is bound.
pub const DOMAIN_V3: &[u8] = b"PID|SOLANA|SMART_ACCOUNT|v3";
/// Domain separator for session-grant payloads (ADR-010). Disjoint from every
/// `SMART_ACCOUNT` domain so an owner signature can never verify as a session
/// grant and vice versa — the same separation the EVM `DOMAIN_PERM` provides.
pub const DOMAIN_SESSION: &[u8] = b"PID|SOLANA|SESSION|v1";

/// V2 operation tags (match the instruction discriminators in `instructions`).
pub const OP_INITIALIZE: u8 = 0;
pub const OP_WITHDRAW_SOL: u8 = 1;
pub const OP_WITHDRAW_TOKEN: u8 = 2;
pub const OP_UPDATE_AUTHORITY: u8 = 3;
pub const OP_CLOSE: u8 = 4;
pub const OP_ACTIVATE: u8 = 5;
/// Generic CPI execution (discriminator 6) — fully generic + self-call deny-list.
pub const OP_EXECUTE: u8 = 6;
/// Session management (discriminators 7-10) under [`DOMAIN_SESSION`].
pub const OP_REGISTER_SESSION: u8 = 7;
pub const OP_SESSION_EXECUTE: u8 = 8;
pub const OP_REVOKE_SESSION: u8 = 9;
pub const OP_CLOSE_SESSION: u8 = 10;

/// Maximum authorization lifetime in seconds, enforced on-chain alongside expiry.
/// Bounds cross-cluster replay: the same PDA exists on every cluster by design,
/// and V1 payloads carry no cluster binding, so a leaked assertion is only live
/// for this window (and only until its nonce is consumed).
pub const MAX_TTL_SECS: i64 = 600;

/// sha256 — pure-Rust implementation (the `sol_sha256` syscall crashes this SBF toolchain).
#[inline(always)]
pub fn sha256(data: &[u8]) -> [u8; 32] {
    crate::sha256::sha256(data)
}

/// Domain-separated V1 authorization payload hash: `sha256(DOMAIN ‖ parts...)`.
/// Frozen legacy — V2 uses [`payload_hash_v2`]. Every part is a fixed-size
/// little-endian/raw field from the program instruction, so the program can
/// recompute it exactly (PRD_v4 §25 domain separation).
#[allow(dead_code)]
pub fn payload_hash(parts: &[&[u8]]) -> [u8; 32] {
    hash_with_domain(DOMAIN, parts)
}

/// Domain-separated V2 authorization payload hash: `sha256(DOMAIN_V2 ‖ parts...)`.
/// Frozen legacy — V3 uses [`payload_hash_v3`].
/// The first part MUST be the one-byte operation tag (`OP_*`).
#[allow(dead_code)]
pub fn payload_hash_v2(parts: &[&[u8]]) -> [u8; 32] {
    hash_with_domain(DOMAIN_V2, parts)
}

/// Domain-separated V3 authorization payload hash: `sha256(DOMAIN_V3 ‖ parts...)`.
/// This is the value the client puts in the WebAuthn challenge (base64url).
/// The first part MUST be the one-byte operation tag (`OP_*`). V3 payloads bind
/// the fee-policy version but no amounts: network costs float with gas by design.
pub fn payload_hash_v3(parts: &[&[u8]]) -> [u8; 32] {
    hash_with_domain(DOMAIN_V3, parts)
}

/// Domain-separated session-grant payload hash: `sha256(DOMAIN_SESSION ‖ parts...)`.
/// Used for owner-signed session lifecycle ops (register/revoke/close). The
/// first part MUST be the one-byte operation tag (`OP_*_SESSION`).
pub fn payload_hash_session(parts: &[&[u8]]) -> [u8; 32] {
    hash_with_domain(DOMAIN_SESSION, parts)
}

fn hash_with_domain(domain: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut buf = [0u8; 256];
    let mut len = 0usize;
    buf[..domain.len()].copy_from_slice(domain);
    len += domain.len();
    for p in parts {
        buf[len..len + p.len()].copy_from_slice(p);
        len += p.len();
    }
    sha256(&buf[..len])
}

/// base64url (RFC 4648 §5, no padding) decode into `out`. Returns bytes written.
fn base64url_decode(input: &[u8], out: &mut [u8]) -> Result<usize, ProgramError> {
    let mut val: u32 = 0;
    let mut bits: u8 = 0;
    let mut written = 0usize;
    for &c in input {
        let d = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err(PeridotError::InvalidChallenge.into()),
        };
        val = (val << 6) | d as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            if written >= out.len() {
                return Err(PeridotError::InvalidChallenge.into());
            }
            out[written] = (val >> bits) as u8;
            written += 1;
            val &= (1u32 << bits) - 1;
        }
    }
    Ok(written)
}

/// Naive subslice search (clientDataJSON is small and this runs once per tx).
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

/// Extract the value of `"challenge":"<base64url>"` from a raw clientDataJSON and decode
/// it into a 32-byte hash.
fn extract_challenge(client_data_json: &[u8], out: &mut [u8; 32]) -> Result<(), ProgramError> {
    const MARKER: &[u8] = b"\"challenge\":\"";
    let pos = find_subslice(client_data_json, MARKER).ok_or(PeridotError::InvalidChallenge)?;
    let start = pos + MARKER.len();
    let rest = &client_data_json[start..];
    let value_len = rest
        .iter()
        .position(|&c| c == b'"')
        .ok_or(PeridotError::InvalidChallenge)?;
    let n = base64url_decode(&rest[..value_len], out)?;
    if n != 32 {
        return Err(PeridotError::InvalidChallenge.into());
    }
    Ok(())
}

/// Full V1 passkey authorization check (frozen legacy — V2 uses
/// [`verify_secp256r1_v2`]). `expected_payload` is the sha256 hash of the
/// domain-separated authorization the program recomputes from its own instruction args.
#[allow(dead_code)]
pub fn verify_secp256r1(
    instructions_account: &AccountView,
    expected_authority: &[u8; 33],
    client_data_json: &[u8],
    expected_payload: &[u8; 32],
) -> Result<(), ProgramError> {
    // The Secp256r1 precompile instruction must be the one immediately after ours.
    let instructions = Instructions::try_from(instructions_account)?;
    let ix = instructions.get_instruction_relative(1)?;
    let secp = Secp256r1Instruction::try_from(&ix)?;

    // 1. The recovered public key must be the account's authority (the passkey).
    let signer = secp.get_signer(0)?;
    if signer != expected_authority {
        return Err(PeridotError::Unauthorized.into());
    }

    // 2. The signed message ends with sha256(clientDataJSON) — binds the exact attested bytes.
    let message = secp.get_message_data(0)?;
    let client_hash = sha256(client_data_json);
    if message.len() < 32 || &message[message.len() - 32..] != &client_hash {
        return Err(PeridotError::InvalidChallenge.into());
    }

    // 3. The challenge inside clientDataJSON must equal the authorization payload — blocks
    //    transaction substitution (the dApp can't show one action and execute another).
    let mut challenge = [0u8; 32];
    extract_challenge(client_data_json, &mut challenge)?;
    if &challenge != expected_payload {
        return Err(PeridotError::InvalidChallenge.into());
    }

    Ok(())
}

/// Full V2 passkey authorization check. `expected_payload` is the V2 payload hash
/// the program recomputes from its own instruction args; `expected_rp_id` is the
/// account's stored RP-ID hash. Enforces the same RP-ID + user-verification
/// semantics as the EVM counterpart (`PeridotAccount._verify`).
pub fn verify_secp256r1_v2(
    instructions_account: &AccountView,
    expected_authority: &[u8; 33],
    expected_rp_id: &[u8; 32],
    client_data_json: &[u8],
    expected_payload: &[u8; 32],
) -> Result<(), ProgramError> {
    // The Secp256r1 precompile instruction must be the one immediately after ours.
    let instructions = Instructions::try_from(instructions_account)?;
    let ix = instructions.get_instruction_relative(1)?;
    let secp = Secp256r1Instruction::try_from(&ix)?;

    // 1. The recovered public key must be the account's authority (the passkey).
    let signer = secp.get_signer(0)?;
    if signer != expected_authority {
        return Err(PeridotError::Unauthorized.into());
    }

    // 2. The signed message must be exactly `authenticatorData ‖ sha256(clientDataJSON)`.
    //    authenticatorData is at least 37 bytes (32B RP-ID hash + flags + counter).
    let message = secp.get_message_data(0)?;
    let client_hash = sha256(client_data_json);
    if message.len() < 37 + 32 || &message[message.len() - 32..] != &client_hash {
        return Err(PeridotError::InvalidChallenge.into());
    }
    let authenticator_data = &message[..message.len() - 32];

    // 3. RP-ID hash + user-verification flag, matching the EVM `_verify` rule.
    if authenticator_data[0..32] != expected_rp_id[..] {
        return Err(PeridotError::Unauthorized.into());
    }
    if authenticator_data[32] & 0x04 == 0 {
        return Err(PeridotError::Unauthorized.into());
    }

    // 4. The challenge inside clientDataJSON must equal the authorization payload — blocks
    //    transaction substitution (the dApp can't show one action and execute another).
    let mut challenge = [0u8; 32];
    extract_challenge(client_data_json, &mut challenge)?;
    if &challenge != expected_payload {
        return Err(PeridotError::InvalidChallenge.into());
    }

    Ok(())
}

/// Reject a signature whose expiry has passed or whose lifetime exceeds
/// `MAX_TTL_SECS` (Clock sysvar). The TTL cap bounds cross-cluster replay of an
/// otherwise-valid signature: the same PDA exists on every cluster by design.
pub fn check_expiry(expiry: i64) -> Result<(), ProgramError> {
    let clock = Clock::get()?;
    if clock.unix_timestamp > expiry {
        return Err(PeridotError::Expired.into());
    }
    if expiry - clock.unix_timestamp > MAX_TTL_SECS {
        return Err(PeridotError::Expired.into());
    }
    Ok(())
}

/// Maximum session lifetime in seconds (24h), enforced at registration against
/// the Clock sysvar. Bounds a stolen session key's usefulness.
pub const SESSION_MAX_TTL_SECS: i64 = 86_400;
/// Session inactivity timeout in seconds (30min). `session_execute` rejects
/// when `now - last_used` exceeds this, then refreshes `last_used`.
pub const SESSION_INACTIVITY_SECS: i64 = 1_800;

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{format, string::String, vec::Vec};

    #[test]
    fn base64url_decodes_32_bytes() {
        let raw = [0x01u8, 0x02, 0x03, 0x04];
        let enc = base64_url_encode(&raw);
        let mut out = [0u8; 4];
        let n = base64url_decode(enc.as_bytes(), &mut out).unwrap();
        assert_eq!(n, 4);
        assert_eq!(out, raw);
    }

    #[test]
    fn extract_challenge_parses_webauthn_client_data() {
        let payload = [0xabu8; 32];
        let json = format!(
            r#"{{"type":"webauthn.get","challenge":"{}","origin":"https://peridot-id.example"}}"#,
            base64_url_encode(&payload)
        );
        let mut out = [0u8; 32];
        extract_challenge(json.as_bytes(), &mut out).unwrap();
        assert_eq!(out, payload);
    }

    #[test]
    fn extract_challenge_rejects_missing_field() {
        let json = br#"{"type":"webauthn.get","origin":"x"}"#;
        let mut out = [0u8; 32];
        assert!(extract_challenge(json, &mut out).is_err());
    }

    #[test]
    fn payload_hash_v2_is_domain_and_op_separated() {
        let account_id = [0x22u8; 32];
        let nonce = 7u64.to_le_bytes();
        let h_v2 = payload_hash_v2(&[&[OP_WITHDRAW_SOL], &account_id, &nonce]);
        // Same fields under the V1 domain must differ.
        let h_v1 = payload_hash(&[&[OP_WITHDRAW_SOL], &account_id, &nonce]);
        assert_ne!(h_v1, h_v2);
        // Same fields under a different op-tag must differ.
        let h_other = payload_hash_v2(&[&[OP_CLOSE], &account_id, &nonce]);
        assert_ne!(h_v2, h_other);
        // Reference computation: sha256(DOMAIN_V2 ‖ parts).
        let mut buf = Vec::new();
        buf.extend_from_slice(DOMAIN_V2);
        buf.extend_from_slice(&[OP_WITHDRAW_SOL]);
        buf.extend_from_slice(&account_id);
        buf.extend_from_slice(&nonce);
        assert_eq!(h_v2, sha256(&buf));
    }

    #[test]
    fn payload_hash_v3_is_domain_separated_from_v2() {
        let account_id = [0x22u8; 32];
        let nonce = 7u64.to_le_bytes();
        let h_v3 = payload_hash_v3(&[&[OP_WITHDRAW_SOL], &account_id, &nonce]);
        let h_v2 = payload_hash_v2(&[&[OP_WITHDRAW_SOL], &account_id, &nonce]);
        let h_v1 = payload_hash(&[&[OP_WITHDRAW_SOL], &account_id, &nonce]);
        assert_ne!(h_v3, h_v2);
        assert_ne!(h_v3, h_v1);
        let mut buf = Vec::new();
        buf.extend_from_slice(DOMAIN_V3);
        buf.extend_from_slice(&[OP_WITHDRAW_SOL]);
        buf.extend_from_slice(&account_id);
        buf.extend_from_slice(&nonce);
        assert_eq!(h_v3, sha256(&buf));
    }

    #[test]
    fn payload_hash_is_domain_separated() {
        let nonce = 7u64.to_le_bytes();
        let amount = 100u64.to_le_bytes();
        let dest = [0x11u8; 32];
        let expiry = 12345i64.to_le_bytes();
        let h = payload_hash(&[&nonce, &amount, &dest, &expiry]);

        // Matches the reference computation in the SDK (Node) — sha256(DOMAIN ‖ fields).
        let mut buf = Vec::new();
        buf.extend_from_slice(DOMAIN);
        buf.extend_from_slice(&nonce);
        buf.extend_from_slice(&amount);
        buf.extend_from_slice(&dest);
        buf.extend_from_slice(&expiry);
        assert_eq!(h, sha256(&buf));
    }

    #[test]
    fn sha256_matches_known_vector() {
        assert_eq!(
            sha256(b"abc"),
            [
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad,
            ]
        );
    }

    fn base64_url_encode(data: &[u8]) -> String {
        const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            out.push(TABLE[(n >> 18) as usize & 0x3f] as char);
            out.push(TABLE[(n >> 12) as usize & 0x3f] as char);
            if chunk.len() > 1 {
                out.push(TABLE[(n >> 6) as usize & 0x3f] as char);
            }
            if chunk.len() > 2 {
                out.push(TABLE[n as usize & 0x3f] as char);
            }
        }
        out
    }
}