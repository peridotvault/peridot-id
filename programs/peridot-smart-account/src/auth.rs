//! secp256r1 passkey authorization verification (ADR 005 Option B — Tier B).
//!
//! The wallet authority is a WebAuthn passkey (secp256r1 / P-256). Its assertion signature
//! covers `authenticatorData ‖ sha256(clientDataJSON)`. The SDK builds a Secp256r1
//! precompile instruction carrying that message plus the recovered 33-byte compressed
//! public key, placed immediately AFTER this program's instruction in the transaction.
//! The program introspects it via the Instructions sysvar and verifies:
//!
//! 1. the recovered public key equals the stored authority (the passkey owns the account);
//! 2. the signed message ends with `sha256(clientDataJSON)` where `clientDataJSON` is a
//!    program argument (binds the exact bytes the passkey attested);
//! 3. the `"challenge"` inside `clientDataJSON` decodes to the authorization payload the
//!    program recomputes from its own arguments (domain ‖ nonce ‖ action ‖ expiry) —
//!    preventing transaction substitution;
//! 4. the expiry has not passed (Clock sysvar).

use crate::errors::PeridotError;
use crate::secp256r1::Secp256r1Instruction;
use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, instructions::Instructions, Sysvar},
    AccountView,
};

/// Domain separator for the signed authorization payload (PRD_v4 §25).
pub const DOMAIN: &[u8] = b"PID|SOLANA|SMART_ACCOUNT|v1";

/// sha256 — pure-Rust implementation (the `sol_sha256` syscall crashes this SBF toolchain).
#[inline(always)]
pub fn sha256(data: &[u8]) -> [u8; 32] {
    crate::sha256::sha256(data)
}

/// Domain-separated authorization payload hash: `sha256(DOMAIN ‖ parts...)`. This is the
/// value the client puts in the WebAuthn challenge (base64url). Every part is a fixed-size
/// little-endian/raw field from the program instruction, so the program can recompute it
/// exactly (PRD_v4 §25 domain separation).
pub fn payload_hash(parts: &[&[u8]]) -> [u8; 32] {
    let mut buf = [0u8; 256];
    let mut len = 0usize;
    buf[..DOMAIN.len()].copy_from_slice(DOMAIN);
    len += DOMAIN.len();
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

/// Full passkey authorization check. `expected_payload` is the sha256 hash of the
/// domain-separated authorization the program recomputes from its own instruction args.
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

/// Reject a signature whose expiry has passed (Clock syscall).
pub fn check_expiry(expiry: i64) -> Result<(), ProgramError> {
    let clock = Clock::get()?;
    if clock.unix_timestamp > expiry {
        return Err(PeridotError::Expired.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::{format, string::String, vec, vec::Vec};

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